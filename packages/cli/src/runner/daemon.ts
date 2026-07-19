import { exec, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { forceKillTree, isShutdownMessage, requestChildShutdown, STOP_FILE_NAME } from "./process-kill.js";
import { ServiceRegistry, type ServiceHandler, type ServiceInitOptions } from "./service-handler.js";
import { TerminalService } from "./services/terminal-service.js";
import { FileExplorerService } from "./services/file-explorer-service.js";
import { GitService, GIT_SIGIL_DEFS } from "./services/git-service.js";
// Resolves @VARIABLE@ tokens used in service panel requires
import { resolvePizzaPiVar } from "../config/io.js";
import { mergeModelLists, readSessionModelsCache, type SessionModelEntry } from "../session-models-cache.js";
import { getCachedOllamaCloudModels } from "../ollama-cloud-models.js";
import { TunnelService } from "./services/tunnel-service.js";
import { TimeService, TIME_TRIGGER_DEFS, TIME_SIGIL_DEFS } from "./services/time-service.js";
import { discoverServices } from "./service-loader.js";
import { globalPluginDirs } from "../plugins/discover.js";
import { io, type Socket } from "socket.io-client";
import {
    SOCKET_PROTOCOL_VERSION,
    type RunnerClientToServerEvents,
    type RunnerServerToClientEvents,
} from "@pizzapi/protocol";
import { TunnelClient } from "@pizzapi/tunnel";
import { loadGlobalConfig, saveGlobalConfig, defaultAgentDir, expandHome, loadConfig } from "../config.js";
import type { PizzaPiConfig } from "../config.js";
import { findSessionPathById } from "./session-list-cache.js";
import { cleanupSessionAttachments, sweepOrphanedAttachments } from "../extensions/session-attachments.js";
import { triggerSessionClose } from "../extensions/providers/extension.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ServiceTriggerDef, ServiceSigilDef, TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { setLogComponent, logInfo, logWarn, logError } from "./logger.js";
import { extractHookSummary } from "./hook-summary.js";
import { sanitizeConfigForUI, restoreMaskedServerEntry, findRenamedServerMatch, MASK_SENTINEL, validateProviderOverridesSection, mergeProviderOverridesSection } from "./daemon-config-sanitize.js";
import { defaultStatePath, acquireStateAndIdentity, releaseStateLock } from "./runner-state.js";
import { normalizeLoopbackHost } from "../relay-url.js";
import { startUsageRefreshLoop, stopUsageRefreshLoop } from "./runner-usage-cache.js";
import { startOllamaModelsRefreshLoop, stopOllamaModelsRefreshLoop } from "./runner-ollama-models-cache.js";
import { getWorkspaceRoots, isCwdAllowed } from "./workspace.js";
import { type RunnerSession, spawnSession } from "./session-spawner.js";
import { pruneSessionCloseMetadata, type SessionCloseMetadata } from "./session-close-metadata.js";

import {
    scanGlobalSkills,
    readSkillContent,
    writeSkill,
    deleteSkill,
} from "../skills.js";

import {
    scanGlobalAgents,
    readAgentContent,
    writeAgent,
    deleteAgent,
} from "../agents.js";

import {
    scanAllPluginInfo,
} from "../plugins.js";

import {
    initUsage,
    triggerScan,
    getData as getUsageData,
    closeUsage,
} from "../usage/index.js";
import type { UsageRange } from "../usage/types.js";

// Re-export migration from shared module — used on daemon startup
import { migrateAgentDir } from "../migrations.js";

/** Map variable name (e.g. "PROJECT_DIR") to camelCase query param key. */
const VAR_TO_PARAM: Record<string, string> = {
    PWD: "pwd",
    SESSION_ID: "sessionId",
    HOME: "home",
    USER: "user",
    PROJECT_DIR: "projectDir",
};

/** Resolve a requires[] array into a panelParams record for the UI. */
function resolveRequires(requires: string[]): Record<string, string> {
    const params: Record<string, string> = {};
    for (const name of requires) {
        const key = VAR_TO_PARAM[name];
        if (key) params[key] = resolvePizzaPiVar(name);
    }
    return params;
}

/**
 * Resolve the set of runner service IDs that should be skipped.
 * Built-in services: "terminal", "file-explorer", "git", "tunnel", "time".
 * Combines the PIZZAPI_DISABLED_RUNNER_SERVICES env var (comma-separated)
 * with the disabledRunnerServices config array.
 */
export function resolveDisabledRunnerServices(
    config: Partial<PizzaPiConfig>,
    envValue: string | undefined = process.env.PIZZAPI_DISABLED_RUNNER_SERVICES,
): Set<string> {
    const fromEnv = envValue
        ? envValue.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const fromConfig = (config.disabledRunnerServices ?? []).filter(
        (s): s is string => typeof s === "string",
    );
    return new Set([...fromEnv, ...fromConfig]);
}

export function resolveReconfiguredDisabledRunnerServices(
    current: Set<string>,
    data: unknown,
): Set<string> | null {
    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    if (typeof payload.serviceId === "string" && typeof payload.enabled === "boolean") {
        const next = new Set(current);
        if (payload.enabled) next.delete(payload.serviceId);
        else next.add(payload.serviceId);
        return next;
    }
    if (Array.isArray(payload.disabledServiceIds)) {
        return new Set(payload.disabledServiceIds.filter((id): id is string => typeof id === "string"));
    }
    return null;
}

export function resolveAnnouncedDisabledRunnerServices(disabledServices: Set<string>): string[] {
    // Announce the configured disabled IDs even when the service is not loaded.
    // Otherwise disabled-at-startup plugins are invisible in the web UI and cannot be re-enabled.
    return Array.from(disabledServices);
}

/**
 * Initialize a list of service handlers, catching per-handler errors so one
 * throwing service cannot block the rest. Already-initialized handlers (present
 * in `initializedIds`) are skipped, so failed services are retried on the next
 * connect and successful services are not double-initialized on reconnect.
 */
export function initServiceHandlers(
    handlers: ServiceHandler[],
    socket: Socket,
    makeOpts: (handler: ServiceHandler) => ServiceInitOptions,
    initializedIds: Set<string>,
): { initialized: string[]; failed: string[] } {
    const initialized: string[] = [];
    const failed: string[] = [];
    for (const handler of handlers) {
        if (initializedIds.has(handler.id)) continue;
        try {
            handler.init(socket, makeOpts(handler));
            initializedIds.add(handler.id);
            initialized.push(handler.id);
        } catch (err) {
            const message = err instanceof Error ? err.stack ?? err.message : String(err);
            logWarn(`[services] init failed for "${handler.id}": ${message}`);
            failed.push(handler.id);
        }
    }
    return { initialized, failed };
}

/**
 * Escalate a SIGTERM to SIGKILL after `timeoutMs` if the child has not exited.
 * The timer is cleared automatically when the child exits.
 * ponytail: child-process escalation is hard to unit-test without real spawned
 * processes; covered by the real SIGTERM/SIGKILL behavior in session-spawner.
 */
function escalateToSigkill(child: ChildProcess, label: string, timeoutMs = 5_000): void {
    const timer = setTimeout(() => {
        try {
            if (!child.killed && child.exitCode === null) {
                logWarn(`[daemon] ${label} did not exit after ${timeoutMs}ms; force-killing`);
                forceKillTree(child);
            }
        } catch {
            // Process already exited; ignore.
        }
    }, timeoutMs);
    child.once("exit", () => clearTimeout(timer));
}

/**
 * Read the `relayUrl` from ~/.pizzapi/config.json, returning undefined
 * if not set or set to "off".  Used as a fallback when PIZZAPI_RELAY_URL
 * env var is not present (e.g. LaunchAgent contexts).
 */
function resolveConfigRelayUrl(): string | undefined {
    const cfg = loadGlobalConfig();
    const url = cfg.relayUrl;
    return url && url !== "off" ? url : undefined;
}

type TriggerReconciliationLogger = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};

/**
 * Reconcile all active subscriptions from a full snapshot into each registered
 * service. Called once after a runner registers with the server so that
 * in-memory state (timers, crons, etc.) is rebuilt from the server's source of
 * truth.
 *
 * @note Snapshot entries are forwarded individually and may contain multiple
 * active subscriptions for the same `(sessionId, triggerType)` pair. Services
 * must treat `subscriptionId` as the stable identity when they maintain
 * runtime state so same-session same-type subscriptions can coexist.
 */
export function applyTriggerSubscriptionDeltaToCache(
    current: TriggerSubscriptionEntry[],
    action: "subscribe" | "update" | "unsubscribe",
    subscription: TriggerSubscriptionEntry,
): TriggerSubscriptionEntry[] {
    const subscriptionId = subscription.subscriptionId;
    const useExactId = subscriptionId && !subscriptionId.startsWith("legacy:all:");
    const matches = (existing: TriggerSubscriptionEntry) => useExactId
        ? existing.subscriptionId === subscriptionId
        : existing.sessionId === subscription.sessionId && existing.triggerType === subscription.triggerType;
    const next = current.filter((existing) => !matches(existing));
    return action === "unsubscribe" ? next : [...next, subscription];
}

export function reconcileSnapshotSubscriptions(
    registry: ServiceRegistry,
    subscriptions: TriggerSubscriptionEntry[],
    logger: TriggerReconciliationLogger = {
        info: logInfo,
        warn: logWarn,
        error: logError,
    },
): { applied: number; errors: string[] } {
    const byServicePrefix = new Map<string, TriggerSubscriptionEntry[]>();
    for (const sub of subscriptions) {
        const prefix = sub.triggerType?.split(":")[0];
        if (!prefix) continue;
        if (!byServicePrefix.has(prefix)) byServicePrefix.set(prefix, []);
        byServicePrefix.get(prefix)!.push(sub);
    }

    for (const [prefix, subs] of byServicePrefix) {
        const service = registry.get(prefix);
        if (!service) {
            logger.warn(`[trigger-reconciliation] no service found for prefix "${prefix}" (${subs.length} subscriptions)`);
            continue;
        }
        if (typeof service.reconcileSubscriptions !== "function") {
            logger.info(`[trigger-reconciliation] service "${prefix}" does not implement reconcileSubscriptions, skipping ${subs.length} subscriptions`);
        }
    }

    let totalApplied = 0;
    const allErrors: string[] = [];

    for (const service of registry.getAll()) {
        if (typeof service.reconcileSubscriptions !== "function") continue;

        const subs = byServicePrefix.get(service.id) ?? [];
        try {
            const result = service.reconcileSubscriptions(subs, { mode: "snapshot" });
            totalApplied += result.applied;
            if (result.errors?.length) allErrors.push(...result.errors);
        } catch (err) {
            const msg = `service "${service.id}" reconcile failed: ${err instanceof Error ? err.message : String(err)}`;
            logger.error(`[trigger-reconciliation] ${msg}`);
            allErrors.push(msg);
        }
    }

    return { applied: totalApplied, errors: allErrors };
}

/**
 * Remote Runner daemon.
 *
 * Connects to the PizzaPi relay server over WebSocket and registers itself as
 * an available runner. The relay server (and through it the web UI) can then:
 *
 *   - Request a new agent session be spawned  (new_session)
 *   - List active sessions                    (list_sessions)
 *   - Kill a session                          (kill_session)
 *
 * Authentication: API key via PIZZAPI_API_KEY env var (required).
 *                (Back-compat: PIZZAPI_RUNNER_TOKEN server token)
 * Relay URL:      PIZZAPI_RELAY_URL env var, or `relayUrl` in ~/.pizzapi/config.json (default: ws://localhost:7492).
 * State file:     PIZZAPI_RUNNER_STATE_PATH env var (default: ~/.pizzapi/runner.json).
 */
export async function runDaemon(_args: string[] = []): Promise<number> {
    setLogComponent("daemon");
    const statePath = defaultStatePath();
    const identity = acquireStateAndIdentity(statePath);

    // Migrate session storage from legacy locations into flat ~/.pizzapi/
    migrateAgentDir();

    // Initialize usage tracking
    initUsage();

    // Read CLI version for reporting to the server.
    // Use module import instead of filesystem path math so this works in:
    //   - source/dev runs (bun src/index.ts runner)
    //   - dist JS runs     (bun dist/index.js runner)
    //   - compiled binaries (where import.meta.url points into Bun's virtual FS)
    let cliVersion: string | undefined;
    try {
        const { default: pkg } = await import("../../package.json");
        cliVersion = typeof pkg?.version === "string" ? pkg.version : undefined;
    } catch {
        // Best-effort — version will be omitted if unreadable.
    }

    // Start fetching provider usage immediately so workers have cached data from
    // the moment they are spawned.  One daemon refresh covers all sessions on this node.
    startUsageRefreshLoop();
    startOllamaModelsRefreshLoop();

    // Load global config so relayUrl and apiKey can be read from
    // ~/.pizzapi/config.json (important for LaunchAgent contexts where
    // env vars aren't available).
    const daemonConfig = loadGlobalConfig();

    // Resolve runner services that should be skipped (config + env var).
    // Use let instead of const to allow mutation during reconfiguration.
    let disabledServices = resolveDisabledRunnerServices(daemonConfig);
    const isServiceDisabled = (id: string) => disabledServices.has(id);

    // Priority: env var > config.json > default
    const apiKey =
        process.env.PIZZAPI_RUNNER_API_KEY ??
        process.env.PIZZAPI_API_KEY ??
        process.env.PIZZAPI_API_TOKEN ??
        daemonConfig.apiKey;
    const token = process.env.PIZZAPI_RUNNER_TOKEN;

    if (!apiKey && !token) {
        logError("Set PIZZAPI_API_KEY (or PIZZAPI_API_TOKEN), or set apiKey in ~/.pizzapi/config.json.");
        releaseStateLock(statePath);
        process.exit(1);
    }

    return new Promise((resolve) => {
        let isShuttingDown = false;

        // ── Socket.IO connection setup ────────────────────────────────────
        // Priority: env var > config.json > default
        const relayRaw = normalizeLoopbackHost(
            (process.env.PIZZAPI_RELAY_URL ?? resolveConfigRelayUrl() ?? "ws://localhost:7492")
                .trim()
                .replace(/\/$/, ""),
        );

        // Normalise the relay URL for socket.io-client (needs http(s)://).
        // If the user supplies a bare hostname (no scheme), default to https://.
        function normaliseRelayUrl(raw: string): string {
            if (raw.startsWith("ws://"))      return raw.replace(/^ws:\/\//, "http://");
            if (raw.startsWith("wss://"))     return raw.replace(/^wss:\/\//, "https://");
            if (raw.startsWith("http://"))    return raw;
            if (raw.startsWith("https://"))   return raw;
            // No scheme — treat as an https host (e.g. "example.com" or "example.com:5173")
            return `https://${raw}`;
        }

        function toTunnelRelayUrl(raw: string): string {
            if (raw.startsWith("http://")) return `${raw.replace(/^http:\/\//, "ws://")}/_tunnel`;
            if (raw.startsWith("https://")) return `${raw.replace(/^https:\/\//, "wss://")}/_tunnel`;
            if (raw.startsWith("ws://") || raw.startsWith("wss://")) return `${raw}/_tunnel`;
            return `wss://${raw}/_tunnel`;
        }

        const sioUrl = normaliseRelayUrl(relayRaw);
        const tunnelRelayUrl = toTunnelRelayUrl(sioUrl);

        const runningSessions = new Map<string, RunnerSession>();
        // Sessions currently in the middle of a restart-in-place (exit code 43).
        // While a sessionId is in this set, the session_ended event arriving from the
        // relay (triggered when the new worker's registerTuiSession tears down the old
        // connection) must be ignored — the new worker is already live.
        const restartingSessions = new Set<string>();
        // Sessions that have been explicitly killed via kill_session.
        // Prevents a race where the worker calls process.exit(43) (restart-in-place)
        // before SIGTERM is delivered — without this guard, exit code 43 in the child's
        // exit handler would trigger doSpawn() even for an explicitly killed session,
        // creating a zombie re-spawn.
        const killedSessions = new Set<string>();
        // Sessions we've already handled session_ended for.  Prevents log
        // spam when the relay fires duplicate session_ended events (e.g. the
        // orphan sweeper runs after the relay already sent session_ended on
        // disconnect).  Entries auto-expire after 5 min — must be comfortably
        // longer than the relay's sweep interval (default 60 s) to avoid
        // re-logging on the next sweep cycle.
        // Map of sessionId → timestamp (ms) when the entry was recorded.
        // A single shared sweep interval purges stale entries rather than
        // scheduling one setTimeout per session (which scales linearly with
        // session churn under high load).
        const endedSessionIds = new Map<string, number>();
        const ENDED_SESSION_TTL_MS = 5 * 60_000;
        const ENDED_SESSION_SWEEP_MS = 60_000; // sweep every 60 s
        const endedSessionSweep = setInterval(() => {
            const now = Date.now();
            for (const [id, ts] of endedSessionIds) {
                if (now - ts >= ENDED_SESSION_TTL_MS) endedSessionIds.delete(id);
            }
        }, ENDED_SESSION_SWEEP_MS);
        const runnerName = process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname();
        let runnerId: string | null = null;
        let isFirstConnect = true;
        // Track which service handlers have successfully completed init(). This
        // replaces the boolean `servicesInitialized` flag: failed services can
        // be retried on the next reconnect, while already-initialized services
        // are not double-initialized.
        const initializedServiceIds = new Set<string>();

        // ── Service registry ──────────────────────────────────────────────
        const registry = new ServiceRegistry();
        if (disabledServices.size > 0) {
            logInfo(`[services] configured disabled services: ${Array.from(disabledServices).join(", ")}`);
        }
        if (isServiceDisabled("terminal")) {
            logInfo('[services] built-in service "terminal" disabled by config');
        } else {
            registry.register(new TerminalService());
        }
        if (isServiceDisabled("file-explorer")) {
            logInfo('[services] built-in service "file-explorer" disabled by config');
        } else {
            registry.register(new FileExplorerService());
        }
        if (isServiceDisabled("git")) {
            logInfo('[services] built-in service "git" disabled by config');
        } else {
            registry.register(new GitService());
        }
        const cleanupGitSessionState = (sessionId: string) => {
            const gitService = registry.get("git");
            if (!gitService) return;
            const maybeGitService = gitService as GitService & { handleSessionEnded?: (id: string) => void };
            maybeGitService.handleSessionEnded?.(sessionId);
        };
        const sessionCloseMetadata = new Map<string, SessionCloseMetadata>();
        const setSessionCloseMetadata = (sessionId: string, metadata: Omit<SessionCloseMetadata, "updatedAt">) => {
            sessionCloseMetadata.set(sessionId, { ...metadata, updatedAt: Date.now() });
            pruneSessionCloseMetadata(sessionCloseMetadata, runningSessions);
        };
        const sessionCloseMetadataSweep = setInterval(() => {
            pruneSessionCloseMetadata(sessionCloseMetadata, runningSessions);
        }, 5 * 60_000);
        const resolveConfiguredAgentDir = (cwd = process.cwd()) => {
            const config = loadConfig(cwd);
            return config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        };
        const listConfiguredModels = (cwd = process.cwd()) => {
            const agentDir = resolveConfiguredAgentDir(cwd);
            const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
            const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
            const diskModels = modelRegistry
                .getAvailable()
                .map((model: any) => ({
                    provider: model.provider,
                    id: model.id,
                    name: model.name,
                    reasoning: model.reasoning,
                    contextWindow: model.contextWindow,
                }));
            // Ollama Cloud models are discovered dynamically and are NOT in the
            // static disk registry. Surface the cached list directly so newer
            // models (e.g. glm-5.2) appear even when no live session has warmed
            // the session snapshot yet. Gated on Ollama credentials so we don't
            // advertise models the runner can't actually use.
            let ollamaModels: SessionModelEntry[] = [];
            if (authStorage.hasAuth("ollama-cloud") || process.env.OLLAMA_API_KEY) {
                ollamaModels = (getCachedOllamaCloudModels() ?? []).map((model) => ({
                    provider: model.provider,
                    id: model.id,
                    name: model.name,
                    reasoning: model.reasoning,
                    contextWindow: model.contextWindow,
                }));
            }
            // Extension-registered providers (pi packages calling registerProvider)
            // only exist inside live sessions — merge the latest session snapshot so
            // Web UI model selectors (Runner Settings, Fast Model) show them too.
            return mergeModelLists(
                mergeModelLists(diskModels, ollamaModels),
                readSessionModelsCache() ?? [],
            );
        };
        const getContextWindowsForAnalysis = (cwd = process.cwd()): Map<string, number> => {
            const windows = new Map<string, number>();
            try {
                for (const model of listConfiguredModels(cwd)) {
                    if (typeof model.contextWindow !== "number") continue;
                    windows.set(`${model.provider}:${model.id}`, model.contextWindow);
                }
            } catch (err) {
                logWarn(`[daemon] Failed to load model context windows for analysis: ${err instanceof Error ? err.message : String(err)}`);
            }
            return windows;
        };
        const normalizeSessionCloseReason = (reason: unknown): "close" | "error" | "complete" => {
            const text = typeof reason === "string" ? reason.toLowerCase() : "";
            if (text.includes("error") || text.includes("crash") || text.includes("orphan")) return "error";
            if (text.includes("complete")) return "complete";
            return "close";
        };
        const resolveSessionFileForClose = async (sessionId: string, explicitSessionFile?: string): Promise<string> => {
            if (explicitSessionFile) return explicitSessionFile;
            const remembered = sessionCloseMetadata.get(sessionId)?.sessionFile;
            if (remembered) return remembered;

            try {
                const sessionsRootDir = join(resolveConfiguredAgentDir(sessionCloseMetadata.get(sessionId)?.cwd), "sessions");
                const found = await findSessionPathById(sessionsRootDir, sessionId);
                if (found) return found;
            } catch {
                // Best-effort only — providers may still be able to use the relay session id.
            }

            return sessionId;
        };
        const notifyProviderSessionClose = async (
            sessionId: string,
            reason: unknown,
            explicitSessionFile?: string,
        ) => {
            const metadata = sessionCloseMetadata.get(sessionId);
            const cwd = metadata?.cwd ?? process.cwd();
            const sessionFile = await resolveSessionFileForClose(sessionId, explicitSessionFile);
            try {
                const closeResult = await triggerSessionClose(
                    sessionId,
                    sessionFile,
                    normalizeSessionCloseReason(reason),
                    cwd,
                );
                if (closeResult) {
                    logInfo(`[daemon] Provider close: ${closeResult.label}`);
                }
            } catch (err) {
                logWarn(`[daemon] Provider close failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        };
        const tunnelService = new TunnelService();
        if (isServiceDisabled("tunnel")) {
            logInfo('[services] built-in service "tunnel" disabled by config');
        } else {
            registry.register(tunnelService);
        }

        const timeService = isServiceDisabled("time") ? null : new TimeService();
        if (timeService) {
            registry.register(timeService);
        } else {
            logInfo('[services] built-in service "time" disabled by config');
        }

        const formatTunnelLog = (...args: unknown[]) => args.map((arg) => {
            if (typeof arg === "string") return arg;
            if (arg instanceof Error) return arg.stack ?? arg.message;
            return String(arg);
        }).join(" ");

        const tunnelClient = apiKey
            ? new TunnelClient({
                runnerId: identity.runnerId,
                apiKey,
                relayUrl: tunnelRelayUrl,
                log: {
                    info: (...args) => logInfo(formatTunnelLog(...args)),
                    debug: (...args) => logInfo(formatTunnelLog(...args)),
                    warn: (...args) => logWarn(formatTunnelLog(...args)),
                    error: (...args) => logError(formatTunnelLog(...args)),
                },
            })
            : null;
        let tunnelClientStarted = false;
        tunnelService.setTunnelClient(tunnelClient);

        // Panel tracking — manifests from folder-based services, ports from announcePanel()
        type PanelEntry = {
            serviceId: string;
            label: string;
            icon: string;
            port?: number;
            /** Trigger types declared in this service's manifest */
            triggers?: ServiceTriggerDef[];
            /** Sigil types declared in this service's manifest */
            sigils?: ServiceSigilDef[];
            /**
             * Whether this service has a UI panel shown to users.
             * false = service has trigger/sigil defs but no panel (e.g. the time service).
             * Defaults to true for plugin-provided services with a panel manifest.
             */
            hasPanel?: boolean;
            /**
             * Variable names the panel requires. The UI resolves these and appends
             * them as query params to the iframe src.
             */
            requires?: string[];
        };
        const panelEntries = new Map<string, PanelEntry>();
        // Track ALL discovered service IDs (including disabled ones) so the UI can show them.
        const allDiscoveredServiceIds = new Set<string>();

        // Register built-in Time service trigger/sigil defs so they flow through service_announce.
        // The Time service has no panel — it only runs an HTTP server for sigil resolve calls.
        // Trigger/sigil defs are tracked via panelEntries (no port here) so they appear in
        // service_announce. The resolve port is tracked separately in sigilServerPorts and
        // stamped onto the sigil defs at announce time.
        if (timeService) {
            panelEntries.set("time", {
                serviceId: "time",
                label: "Time",
                icon: "clock",
                hasPanel: false,
                triggers: TIME_TRIGGER_DEFS,
                sigils: TIME_SIGIL_DEFS,
            });
        }

        // Register built-in Git service sigil defs so they flow through service_announce.
        // The git panel is a native UI component (not an iframe), so hasPanel:false — this
        // entry exists only to advertise git-domain sigils; they render client-side (no resolve).
        if (!isServiceDisabled("git")) {
            panelEntries.set("git", {
                serviceId: "git",
                label: "Git",
                icon: "git-branch",
                hasPanel: false,
                sigils: GIT_SIGIL_DEFS,
            });
        }

        // Ports for services that run an HTTP resolve server but have no UI panel.
        // Keyed by serviceId. Populated when the service calls announceSigilServer().
        const sigilServerPorts = new Map<string, number>();

        /** Emit service_announce with current service IDs, panel metadata, and trigger defs. */
        const emitServiceAnnounce = () => {
            const allServiceIds = registry.getAll().map((s) => s.id);
            const activeServiceIds = new Set(allServiceIds);
            const disabledServiceIds = resolveAnnouncedDisabledRunnerServices(disabledServices);
            // Map panel entries to ServicePanelInfo, resolving requires → panelParams
            const panels = Array.from(panelEntries.values())
                .filter((p): p is PanelEntry & { port: number } => activeServiceIds.has(p.serviceId) && p.port != null && p.hasPanel !== false)
                .map((p) => ({
                    serviceId: p.serviceId,
                    port: p.port,
                    label: p.label,
                    icon: p.icon,
                    ...(p.requires ? { panelParams: resolveRequires(p.requires) } : {}),
                }));
            // Collect all trigger defs and sigil defs across all services with manifests
            const allTriggerDefs: ServiceTriggerDef[] = [];
            const allSigilDefs: ServiceSigilDef[] = [];
            for (const entry of panelEntries.values()) {
                if (!activeServiceIds.has(entry.serviceId)) continue;
                if (entry.triggers && entry.triggers.length > 0) {
                    allTriggerDefs.push(...entry.triggers);
                }
                if (entry.sigils && entry.sigils.length > 0) {
                    // Stamp serviceId and (if available) resolvePort onto each sigil def.
                    // resolvePort lets the UI route resolve calls to panel-less services.
                    const resolvePort = sigilServerPorts.get(entry.serviceId);
                    for (const sigil of entry.sigils) {
                        allSigilDefs.push({
                            ...sigil,
                            serviceId: entry.serviceId,
                            ...(resolvePort != null ? { resolvePort } : {}),
                        });
                    }
                }
            }
            (socket as any).emit("service_announce", {
                serviceIds: allServiceIds,
                ...(disabledServiceIds.length > 0 ? { disabledServiceIds } : {}),
                ...(panels.length > 0 ? { panels } : {}),
                ...(allTriggerDefs.length > 0 ? { triggerDefs: allTriggerDefs } : {}),
                ...(allSigilDefs.length > 0 ? { sigilDefs: allSigilDefs } : {}),
            });
        };

        // Discover and register plugin-provided services.
        // pluginServicesReady resolves once discovery + registration is complete.
        // The runner_registered handler awaits this before announcing services.
        let resolvePluginServices: () => void;
        const pluginServicesReady = new Promise<void>(r => { resolvePluginServices = r; });
        discoverServices({ pluginDirs: globalPluginDirs(), disabledIds: disabledServices }).then(({ services, errors }) => {
            for (const { handler, source, manifest } of services) {
                try {
                    registry.register(handler);
                    allDiscoveredServiceIds.add(handler.id);
                    logInfo(`[services] loaded plugin service "${handler.id}" from ${source.pluginName ?? source.path}`);
                    // Track panel metadata and trigger defs from folder-based services
                    if (manifest?.panel || (manifest?.triggers && manifest.triggers.length > 0) || (manifest?.sigils && manifest.sigils.length > 0)) {
                        const existing = panelEntries.get(handler.id);
                        panelEntries.set(handler.id, {
                            serviceId: handler.id,
                            label: manifest.label,
                            icon: manifest.icon,
                            ...(existing?.port !== undefined ? { port: existing.port } : {}),
                            ...(manifest.triggers && manifest.triggers.length > 0
                                ? { triggers: manifest.triggers }
                                : {}),
                            ...(manifest.sigils && manifest.sigils.length > 0
                                ? { sigils: manifest.sigils }
                                : {}),
                            ...(manifest.panel?.requires
                                ? { requires: manifest.panel.requires }
                                : {}),
                        });
                    }
                } catch (err) {
                    logWarn(`[services] failed to register plugin service "${handler.id}": ${err}`);
                }
            }
            for (const { path, error } of errors) {
                logWarn(`[services] plugin service load error at ${path}: ${error}`);
            }
        }).catch(err => {
            logWarn(`[services] plugin service discovery failed: ${err}`);
        }).finally(() => {
            resolvePluginServices!();
        });

        const socket: Socket<RunnerServerToClientEvents, RunnerClientToServerEvents> = io(
            sioUrl + "/runner",
            {
                auth: {
                    apiKey,
                    runnerId: identity.runnerId,
                    runnerSecret: identity.runnerSecret,
                    protocolVersion: SOCKET_PROTOCOL_VERSION,
                    ...(cliVersion ? { clientVersion: cliVersion } : {}),
                },
                transports: ["websocket"],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 30000,
            },
        );

        socket.io.on("reconnect_attempt", (attempt) => {
            logInfo(`[relay] reconnect attempt ${attempt} to ${sioUrl}/runner`);
        });
        socket.io.on("reconnect_error", (err) => {
            logWarn(`[relay] reconnect error: ${err instanceof Error ? err.message : String(err)}`);
        });
        socket.io.on("reconnect", (attempt) => {
            logInfo(`[relay] reconnected after ${attempt} attempt(s)`);
        });
        socket.io.on("error", (err) => {
            logWarn(`[relay] manager error: ${err instanceof Error ? err.message : String(err)}`);
        });

        // Service init happens in runner_registered after plugin discovery completes.

        if (tunnelClient) {
            tunnelClient.on("registered", () => {
                logInfo(`[tunnel] registered at ${tunnelRelayUrl}`);
                tunnelService.setTunnelClient(tunnelClient);
                // Clear any previous tunnel warning now that we're connected
                socket.emit("runner_warning_clear", {} as Record<string, never>);
            });
            tunnelClient.on("disconnect", () => {
                if (!isShuttingDown) {
                    logInfo(`[tunnel] disconnected from ${tunnelRelayUrl}`);
                }
            });
            tunnelClient.on("error", (error) => {
                logError(`[tunnel] ${error instanceof Error ? error.message : String(error)}`);
            });
            tunnelClient.on("disabled", (data: { reason: string; failures: number; relayUrl: string }) => {
                logWarn(`[tunnel] disabled after ${data.failures} failed connection attempts to ${data.relayUrl}`);
                logWarn("[tunnel] The relay server may not support the /_tunnel endpoint. Upgrade the server with 'pizza web'.");
                // Surface as a visible warning in the web UI
                socket.emit("runner_warning", {
                    message: "Tunnel unavailable — the relay server does not support the tunnel endpoint. Upgrade with 'pizza web' to enable tunnels and service panels.",
                });
            });
        } else {
            logWarn("[tunnel] disabled: runner is missing an API key for tunnel authentication");
        }

        logInfo(`connecting to relay at ${sioUrl}/runner…`);

        // Start periodic usage scan (every 5 minutes)
        const usageScanInterval = setInterval(() => {
            triggerScan();
        }, 5 * 60 * 1000);

        // Windows `runner stop` cannot deliver a catchable signal — it drops a
        // stop file next to the state file instead; poll for it. A stale file
        // from an earlier unclean exit is cleared before polling starts.
        const stopFilePath = join(dirname(statePath), STOP_FILE_NAME);
        try { rmSync(stopFilePath, { force: true }); } catch {}
        const stopFilePoll = setInterval(() => {
            if (existsSync(stopFilePath)) {
                try { rmSync(stopFilePath, { force: true }); } catch {}
                logInfo("stop requested via stop file — shutting down");
                void shutdown(0);
            }
        }, 1_000);

        const shutdown = async (code: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            clearInterval(stopFilePoll);
            clearInterval(endedSessionSweep);
            clearInterval(sessionCloseMetadataSweep);
            clearInterval(usageScanInterval);
            void tunnelClient?.dispose();
            registry.disposeAll();
            stopUsageRefreshLoop();
            stopOllamaModelsRefreshLoop();
            await closeUsage().catch((err) =>
                logError("closeUsage failed during shutdown: " + (err instanceof Error ? err.message : String(err))),
            );
            releaseStateLock(statePath);
            socket.disconnect();
            resolve(code);
        };

        process.on("SIGINT", () => shutdown(0));
        process.on("SIGTERM", () => shutdown(0));
        // Windows: the supervisor requests shutdown over IPC because a signal
        // would TerminateProcess us before any of the cleanup above could run.
        process.on("message", (msg: unknown) => {
            if (isShutdownMessage(msg)) void shutdown(0);
        });

        // ── Helper: emit registration ─────────────────────────────────────
        const emitRegister = () => {
            const skills = scanGlobalSkills();
            const agents = scanGlobalAgents();
            // Runner registration only advertises global plugins.
            // Project-local plugins are session-scoped — they're discovered
            // per-session via list_plugins with an explicit cwd.
            // Pass undefined as cwd so that discoverClaudeInstalledPlugins
            // skips project-scoped marketplace plugins and readEnabledPlugins
            // only reads user-level settings (not project-local overrides).
            const plugins = scanAllPluginInfo(undefined, { includeProjectLocal: false });
            const globalConfig = loadGlobalConfig();
            const hooks = extractHookSummary(globalConfig.hooks);
            socket.emit("register_runner", {
                runnerId: identity.runnerId,
                runnerSecret: identity.runnerSecret,
                name: runnerName,
                roots: getWorkspaceRoots(),
                skills,
                agents,
                plugins,
                hooks,
                version: cliVersion,
                platform: process.platform,
            });
        };

        // ── Connection lifecycle ──────────────────────────────────────────

        socket.on("connect", () => {
            if (isShuttingDown) {
                socket.disconnect();
                return;
            }
            if (tunnelClient && !tunnelClientStarted) {
                tunnelClientStarted = true;
                tunnelClient.connect();
            }
            const verb = isFirstConnect ? "connected" : "reconnected";
            isFirstConnect = false;
            logInfo(`${verb}. Registering as ${identity.runnerId}…`);
            emitRegister();
        });

        socket.on("disconnect", (reason, details) => {
            if (isShuttingDown) return;
            const engine = socket.io.engine;
            const transportName = engine?.transport?.name ?? "unknown";
            logInfo(
                `disconnected (${reason}). Socket.IO will reconnect automatically. `
                + `transport=${transportName} details=${JSON.stringify(details ?? {})}`,
            );
        });

        // ── Registration confirmation ─────────────────────────────────────

        socket.on("runner_registered", async (data: any) => {
            // Fix 3 (P2): wrap the entire handler in try/catch so that any
            // service init() error doesn't silently swallow and leave the
            // daemon in a half-initialized state.
            try {
                runnerId = data.runnerId;
                lastAppliedRevision = -1;
                if (runnerId !== identity.runnerId) {
                    logWarn(`server assigned unexpected ID ${runnerId} (expected ${identity.runnerId})`);
                }
                logInfo(`registered as ${runnerId}`);

                // Wait for plugin service discovery to finish, then init ALL services
                // (built-in + plugins) once and announce the full list.
                // Guard against a hung plugin dynamic import that would otherwise block
                // registration forever — proceed with whatever services are ready.
                const PLUGIN_DISCOVERY_TIMEOUT_MS = 30_000;
                let pluginDiscoveryTimedOut = false;
                await Promise.race([
                    pluginServicesReady,
                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            pluginDiscoveryTimedOut = true;
                            resolve();
                        }, PLUGIN_DISCOVERY_TIMEOUT_MS);
                    }),
                ]);
                if (pluginDiscoveryTimedOut) {
                    logWarn(`[services] plugin discovery did not complete within ${PLUGIN_DISCOVERY_TIMEOUT_MS}ms; proceeding with already-loaded services`);
                }
                const allServiceIds = registry.getAll().map((s) => s.id);

                // Build announcePanel callback — when a service calls it, we register
                // the port with the tunnel service and re-announce to viewers.
                const announcePanel = (serviceId: string) => (port: number) => {
                    const entry = panelEntries.get(serviceId);
                    if (!entry) return;
                    entry.port = port;
                    tunnelService.registerPort(port, entry.label);
                    logInfo(`[services] panel announced for "${serviceId}" on port ${port}`);
                    // Re-announce so viewers pick up the panel
                    emitServiceAnnounce();
                };

                // Build announceSigilServer callback — for services that run an HTTP resolve
                // server but have no UI panel. Registers with the tunnel for routing and
                // stamps the port onto sigil defs in service_announce, without adding the
                // service to the panels array.
                const announceSigilServer = (serviceId: string) => (port: number) => {
                    sigilServerPorts.set(serviceId, port);
                    tunnelService.registerPort(port, serviceId);
                    logInfo(`[services] sigil resolve server announced for "${serviceId}" on port ${port}`);
                    emitServiceAnnounce();
                };

                // Socket.IO reconnects reuse this same Socket instance, so service
                // listeners registered during a successful init remain attached.
                // Re-running init() on reconnect would duplicate socket handlers and may
                // respawn service-owned resources; only init handlers that have not yet
                // succeeded. Failed services are retried on the next connect.
                const initResult = initServiceHandlers(
                    registry.getAll(),
                    socket,
                    (handler) => {
                        const opts: ServiceInitOptions = { isShuttingDown: () => isShuttingDown };
                        const entry = panelEntries.get(handler.id);
                        if (entry) {
                            if (entry.hasPanel !== false) {
                                opts.announcePanel = announcePanel(handler.id);
                            } else {
                                opts.announceSigilServer = announceSigilServer(handler.id);
                            }
                        }
                        return opts;
                    },
                    initializedServiceIds,
                );

                if (initResult.failed.length > 0) {
                    logWarn(`[services] ${initResult.failed.length} service(s) failed to initialize: ${initResult.failed.join(", ")}`);
                }
                if (initResult.initialized.length === 0) {
                    logInfo(`[services] reconnected; preserving ${initializedServiceIds.size} initialized service(s): ${Array.from(initializedServiceIds).join(", ") || "none"}`);
                } else {
                    logInfo(`[services] initialized ${initResult.initialized.length} new service(s); ${initializedServiceIds.size}/${allServiceIds.length} total initialized: ${Array.from(initializedServiceIds).join(", ") || "none"}`);
                }

                // Re-announce service metadata after every registration so viewers and
                // freshly restarted relays rebuild their service/panel/sigil caches.
                emitServiceAnnounce();

                // Re-adopt orphaned sessions that survived a daemon restart.
                // Their worker processes are still running and connected to the relay.
                const existingSessions = data.existingSessions ?? [];
                if (existingSessions.length > 0) {
                    let adopted = 0;
                    for (const { sessionId, cwd, sessionFile } of existingSessions) {
                        if (runningSessions.has(sessionId)) continue; // already tracked
                        runningSessions.set(sessionId, {
                            sessionId,
                            child: null,
                            startedAt: Date.now(),
                            adopted: true,
                            ...(typeof sessionFile === "string" && sessionFile ? { sessionFile } : {}),
                        });
                        setSessionCloseMetadata(sessionId, {
                            cwd: typeof cwd === "string" && cwd ? cwd : process.cwd(),
                            ...(typeof sessionFile === "string" && sessionFile ? { sessionFile } : {}),
                        });
                        adopted++;
                    }
                    if (adopted > 0) {
                        logInfo(`re-adopted ${adopted} orphaned session(s): ${existingSessions.map((s: any) => s.sessionId.slice(0, 8)).join(", ")}`);
                    }
                }

                // Sweep orphaned session attachment directories — removes dirs for
                // sessions that ended while the daemon was down or crashed.
                void sweepOrphanedAttachments(new Set(runningSessions.keys())).catch(() => {});
            } catch (err) {
                logError(`[daemon] runner_registered handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            }
        });

        let cachedTriggerSubscriptions: TriggerSubscriptionEntry[] = [];

        // ── Service reconfiguration ───────────────────────────────────────
        // Update the disabled services list at runtime and reinitialize services.
        socket.on("reconfigure_services", async (data: any) => {
            if (isShuttingDown) return;
            try {
                const newDisabledServices = resolveReconfiguredDisabledRunnerServices(disabledServices, data);
                if (!newDisabledServices) {
                    logWarn("[services] invalid reconfigure_services payload");
                    return;
                }

                logInfo(`[services] reconfiguring: disabling ${Array.from(newDisabledServices).join(", ") || "none"}`);

                // Update config on disk
                const currentConfig = loadGlobalConfig();
                saveGlobalConfig({ ...currentConfig, disabledRunnerServices: Array.from(newDisabledServices) });

                // Update runtime disabled set
                disabledServices = newDisabledServices;

                const optsForInit = (id: string): any => {
                    const opts: any = { isShuttingDown: () => isShuttingDown };
                    const entry = panelEntries.get(id);
                    if (entry) {
                        if (entry.hasPanel !== false) {
                            opts.announcePanel = (port: number) => {
                                entry.port = port;
                                tunnelService.registerPort(port, entry.label);
                                logInfo(`[services] panel announced for "${id}" on port ${port}`);
                                emitServiceAnnounce();
                            };
                        } else {
                            opts.announceSigilServer = (port: number) => {
                                sigilServerPorts.set(id, port);
                                tunnelService.registerPort(port, id);
                                logInfo(`[services] sigil resolve server announced for "${id}" on port ${port}`);
                                emitServiceAnnounce();
                            };
                        }
                    }
                    return opts;
                };

                // Disable plugin services that are now in the disabled set
                const BUILTIN_IDS = new Set(["terminal", "file-explorer", "git", "tunnel", "time"]);
                const pluginsToDisable = registry.getAll()
                    .filter(s => !BUILTIN_IDS.has(s.id) && newDisabledServices.has(s.id));
                for (const svc of pluginsToDisable) {
                    logInfo(`[services] disabling plugin service "${svc.id}"`);
                    try {
                        svc.dispose();
                    } catch (err) {
                        logWarn(`[services] dispose failed for "${svc.id}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
                    }
                    registry.unregister(svc.id);
                    initializedServiceIds.delete(svc.id);
                    // Keep panel entry for disabled services so they still appear in service_announce
                    sigilServerPorts.delete(svc.id);
                }

                // Re-discover plugin services with new disabled list
                const { services: discoveredServices, errors } = await discoverServices(
                    { pluginDirs: globalPluginDirs(), disabledIds: newDisabledServices },
                );

                // Remove services that are no longer discoverable (plugin deleted) and not disabled
                for (const id of allDiscoveredServiceIds) {
                    if (newDisabledServices.has(id)) continue; // Keep disabled services
                    if (discoveredServices.some(s => s.handler.id === id)) continue; // Still exists
                    // Plugin was removed and is not disabled - clean up
                    allDiscoveredServiceIds.delete(id);
                    panelEntries.delete(id);
                    sigilServerPorts.delete(id);
                }

                // Register any newly enabled plugin services
                for (const { handler, source, manifest } of discoveredServices) {
                    if (registry.has(handler.id)) continue;
                    allDiscoveredServiceIds.add(handler.id);
                    try {
                        registry.register(handler);
                        logInfo(`[services] loaded plugin service "${handler.id}" from ${source.pluginName ?? source.path}`);
                        if (manifest?.panel || (manifest?.triggers && manifest.triggers.length > 0) || (manifest?.sigils && manifest.sigils.length > 0)) {
                            panelEntries.set(handler.id, {
                                serviceId: handler.id,
                                label: manifest.label,
                                icon: manifest.icon,
                                ...(manifest.triggers && manifest.triggers.length > 0 ? { triggers: manifest.triggers } : {}),
                                ...(manifest.sigils && manifest.sigils.length > 0 ? { sigils: manifest.sigils } : {}),
                                ...(manifest.panel?.requires ? { requires: manifest.panel.requires } : {}),
                            });
                        }
                        handler.init(socket, optsForInit(handler.id));
                        initializedServiceIds.add(handler.id);
                        if (typeof handler.reconcileSubscriptions === "function") {
                            const subs = cachedTriggerSubscriptions.filter((sub) => sub.triggerType?.split(":")[0] === handler.id);
                            const result = handler.reconcileSubscriptions(subs, { mode: "snapshot" });
                            logInfo(`[trigger-reconciliation] service "${handler.id}" hot-reload applied ${result.applied}/${subs.length} cached subscriptions${result.errors?.length ? `, errors=${result.errors.length}` : ""}`);
                        }
                    } catch (err) {
                        logWarn(`[services] failed to register plugin service "${handler.id}": ${err}`);
                    }
                }

                for (const { path, error } of errors) {
                    logWarn(`[services] plugin service load error at ${path}: ${error}`);
                }

                // Re-announce services
                emitServiceAnnounce();

                logInfo(`[services] reconfiguration complete. Active services: ${registry.getAll().map(s => s.id).join(", ")}`);
            } catch (err) {
                logError(`[services] reconfigure_services handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            }
        });

        // ── Trigger subscription reconciliation ──────────────────────────

        // Track the last applied revision to ignore stale/duplicate messages.
        // -1 means "accept the next snapshot/delta regardless of revision" and is
        // used on initial startup and after relay re-registration, because the
        // server-side revision counter is process-local and restarts from 0/1.
        let lastAppliedRevision = -1;

        (socket as any).on("trigger_subscriptions_snapshot", (data: any) => {
            if (isShuttingDown) return;
            try {
                const { revision, subscriptions, isReconnect } = data ?? {};
                if (typeof revision !== "number" || !Array.isArray(subscriptions)) {
                    logWarn("[trigger-reconciliation] invalid snapshot payload");
                    return;
                }

                // Reconnect snapshots are authoritative full baselines: they must be
                // applied unconditionally regardless of any revision the daemon has
                // already seen.  Without this, the following lost-baseline race can
                // occur on reconnect:
                //   1. Server reserves snapshotRevision=N BEFORE the async read.
                //   2. A concurrent delta fires at revision=N+1 (higher, as intended).
                //   3. The delta reaches the daemon first → lastAppliedRevision = N+1.
                //   4. The snapshot arrives at revision=N → dropped as stale (N ≤ N+1).
                //   5. All pre-existing subscriptions NOT covered by the delta are
                //      silently missing after reconnect.
                //
                // By resetting lastAppliedRevision to 0 when isReconnect=true we force
                // the snapshot to be accepted, while still allowing any subsequent
                // delta (revision > snapshotRevision) to be applied on top of it.
                if (isReconnect) {
                    lastAppliedRevision = 0;
                    logInfo(`[trigger-reconciliation] accepting reconnect snapshot revision=${revision} as authoritative baseline (resetting stale-drop counter)`);
                }

                // Ignore stale snapshots (e.g. from a retransmission).
                if (revision <= lastAppliedRevision) {
                    logInfo(`[trigger-reconciliation] ignoring stale snapshot revision=${revision} (last=${lastAppliedRevision})`);
                    return;
                }
                lastAppliedRevision = revision;

                logInfo(`[trigger-reconciliation] received snapshot revision=${revision} with ${subscriptions.length} subscriptions`);
                cachedTriggerSubscriptions = subscriptions as TriggerSubscriptionEntry[];

                const { applied: totalApplied, errors: allErrors } = reconcileSnapshotSubscriptions(registry, cachedTriggerSubscriptions);

                // Ack back to the server
                socket.emit("trigger_subscriptions_applied" as any, {
                    revision,
                    applied: totalApplied,
                    ...(allErrors.length > 0 ? { errors: allErrors } : {}),
                });

                logInfo(`[trigger-reconciliation] applied ${totalApplied} subscriptions from snapshot revision=${revision}${allErrors.length ? `, ${allErrors.length} errors` : ""}`);
            } catch (err) {
                logError(`[trigger-reconciliation] snapshot handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            }
        });

        (socket as any).on("trigger_subscription_delta", (data: any) => {
            if (isShuttingDown) return;
            try {
                const { revision, action, subscription } = data ?? {};
                if (
                    typeof revision !== "number" ||
                    (action !== "subscribe" && action !== "update" && action !== "unsubscribe") ||
                    !subscription?.triggerType
                ) {
                    logWarn("[trigger-reconciliation] invalid delta payload");
                    return;
                }

                // Ignore stale deltas.
                if (revision <= lastAppliedRevision) {
                    logInfo(`[trigger-reconciliation] ignoring stale delta revision=${revision} (last=${lastAppliedRevision})`);
                    return;
                }
                lastAppliedRevision = revision;

                const typedSubscription = subscription as TriggerSubscriptionEntry;
                cachedTriggerSubscriptions = applyTriggerSubscriptionDeltaToCache(cachedTriggerSubscriptions, action, typedSubscription);

                const prefix = typedSubscription.triggerType.split(":")[0];
                if (!prefix) return;

                let applied = 0;
                const errors: string[] = [];
                const service = registry.get(prefix);
                if (!service) {
                    logWarn(`[trigger-reconciliation] no service found for prefix "${prefix}" (delta ${action})`);
                } else if (typeof service.reconcileSubscriptions !== "function") {
                    logInfo(`[trigger-reconciliation] service "${prefix}" does not implement reconcileSubscriptions, skipping delta ${action}`);
                } else {
                    try {
                        const result = service.reconcileSubscriptions([typedSubscription], {
                            mode: "delta",
                            action,
                        });
                        applied += result.applied;
                        if (result.errors?.length) errors.push(...result.errors);
                    } catch (err) {
                        const msg = `service "${prefix}" reconcile failed: ${err instanceof Error ? err.message : String(err)}`;
                        logError(`[trigger-reconciliation] ${msg}`);
                        errors.push(msg);
                    }
                }

                socket.emit("trigger_subscriptions_applied" as any, {
                    revision,
                    applied,
                    ...(errors.length > 0 ? { errors } : {}),
                });

                logInfo(`[trigger-reconciliation] delta: ${action} ${subscription.triggerType} for session ${subscription.sessionId} applied=${applied}${errors.length ? ` errors=${errors.length}` : ""}`);
            } catch (err) {
                logError(`[trigger-reconciliation] delta handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            }
        });

        // ── Session management ────────────────────────────────────────────

        socket.on("new_session", async (data: any) => {
            if (isShuttingDown) return;
            const { sessionId, cwd: requestedCwd, prompt: requestedPrompt, model: requestedModel, hiddenModels: requestedHiddenModels, agent: requestedAgent, parentSessionId: requestedParentSessionId, resumePath: requestedResumePath, resumeId: requestedResumeId, autoClose: requestedAutoClose } = data;

            if (!sessionId) {
                socket.emit("session_error", { sessionId: sessionId ?? "", message: "Missing sessionId" });
                return;
            }

            // The worker uses the runner's API key to register with the /relay namespace.
            if (!apiKey) {
                socket.emit("session_error", { sessionId, message: "Runner is missing PIZZAPI_API_KEY" });
                return;
            }

            // Resolve agent definition from disk when only a name is provided.
            // The UI sends { name: "researcher" } and the daemon resolves the
            // full agent file content so the worker can apply it.
            let resolvedAgent = requestedAgent;
            if (resolvedAgent?.name && !resolvedAgent.systemPrompt) {
                const content = readAgentContent(resolvedAgent.name);
                if (content) {
                    // Parse frontmatter to extract tools/disallowedTools, then use body as systemPrompt
                    const fmEnd = content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
                    let body = content;
                    let tools = resolvedAgent.tools;
                    let disallowedTools = resolvedAgent.disallowedTools;
                    if (fmEnd !== -1) {
                        const fmBlock = content.slice(3, fmEnd);
                        body = content.slice(fmEnd + 4).trim();
                        // Extract tools from frontmatter if not explicitly provided
                        if (!tools) {
                            const toolsMatch = fmBlock.match(/^tools:\s*(.+)$/m);
                            if (toolsMatch) tools = toolsMatch[1].trim().replace(/^["']|["']$/g, "");
                        }
                        if (!disallowedTools) {
                            const dtMatch = fmBlock.match(/^disallowedTools:\s*(.+)$/m);
                            if (dtMatch) disallowedTools = dtMatch[1].trim().replace(/^["']|["']$/g, "");
                        }
                    }
                    resolvedAgent = { ...resolvedAgent, systemPrompt: body, tools, disallowedTools };
                } else {
                    logWarn(`agent "${resolvedAgent.name}" not found on disk`);
                    socket.emit("session_error", { sessionId, message: `Agent "${resolvedAgent.name}" not found on this runner` });
                    return;
                }
            }

            // Resolve resumeId → resumePath if needed.
            // When the UI has a session ID but not the .jsonl file path (e.g.
            // from server-side persisted sessions), it sends resumeId and the
            // daemon resolves the path from the local session cache/filesystem.
            let resolvedResumePath = typeof requestedResumePath === "string" ? requestedResumePath : undefined;
            if (!resolvedResumePath && typeof requestedResumeId === "string" && requestedResumeId) {
                const sessionsRootDir = join(resolveConfiguredAgentDir(requestedCwd), "sessions");
                try {
                    const found = await findSessionPathById(sessionsRootDir, requestedResumeId);
                    if (found) {
                        resolvedResumePath = found;
                        logInfo(`resolved resumeId ${requestedResumeId} → ${found}`);
                    } else {
                        logWarn(`resumeId ${requestedResumeId} not found in ${sessionsRootDir}`);
                    }
                } catch (err) {
                    logWarn(`failed to resolve resumeId ${requestedResumeId}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            let isFirstSpawn = true;
            const doSpawn = () => {
                try {
                    // Only pass initial prompt/model on the first spawn.
                    // On restart (exit code 43), the session already has
                    // the prompt in its history — re-sending would duplicate it.
                    const spawnOpts = isFirstSpawn
                        ? { prompt: requestedPrompt, model: requestedModel, hiddenModels: requestedHiddenModels, agent: resolvedAgent, parentSessionId: requestedParentSessionId, resumePath: resolvedResumePath, autoClose: requestedAutoClose === true }
                        : { hiddenModels: requestedHiddenModels, agent: resolvedAgent, parentSessionId: requestedParentSessionId, autoClose: requestedAutoClose === true }; // Always pass agent + hidden models + parent + autoClose on restart
                    isFirstSpawn = false;
                    spawnSession(sessionId, apiKey!, relayRaw, requestedCwd, runningSessions, restartingSessions, killedSessions, doSpawn, spawnOpts);
                    setSessionCloseMetadata(sessionId, {
                        cwd: requestedCwd ?? process.cwd(),
                        ...(resolvedResumePath ? { sessionFile: resolvedResumePath } : {}),
                    });
                    socket.emit("session_ready", { sessionId });
                    // No need to re-emit service_announce here — the server
                    // persists the announce data in Redis and sends it to
                    // viewers automatically when they connect to a session.
                } catch (err) {
                    socket.emit("session_error", {
                        sessionId,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            };
            doSpawn();
        });

        socket.on("kill_session", async (data: any) => {
            if (isShuttingDown) return;
            const { sessionId } = data;
            const entry = runningSessions.get(sessionId);
            if (entry) {
                if (entry.child) {
                    try {
                        // Mark as killed BEFORE requesting shutdown so the child's
                        // exit handler sees it even if exit code 43 (restart-in-place)
                        // arrives before the shutdown request is delivered.
                        killedSessions.add(sessionId);
                        // SIGTERM on POSIX; IPC shutdown message on Windows (where
                        // kill() would TerminateProcess and skip worker cleanup).
                        const child = entry.child;
                        requestChildShutdown(child, (timeoutMs) =>
                            logWarn(`[daemon] session ${sessionId} did not exit after ${timeoutMs}ms; force-killing`),
                        );
                    } catch {}
                } else if (entry.adopted) {
                    // No child handle — ask the relay to disconnect the worker's
                    // socket, which sends end_session then force-disconnects.
                    socket.emit("disconnect_session", { sessionId });
                }
                runningSessions.delete(sessionId);
                endedSessionIds.set(sessionId, Date.now());
                await notifyProviderSessionClose(sessionId, "close", entry.sessionFile);
                cleanupGitSessionState(sessionId);
                sessionCloseMetadata.delete(sessionId);
                logInfo(`killed session ${sessionId}${entry.adopted ? " (adopted)" : ""}`);
                socket.emit("session_killed", { sessionId });
                // Clean up persisted attachments for this session
                void cleanupSessionAttachments(sessionId).catch(() => {});
            }
        });

        // ── session_ended — relay notifies us a worker disconnected ───────
        socket.on("session_ended", async (data: any) => {
            if (isShuttingDown) return;
            const { sessionId, reason, sessionFile } = data;

            // If this session just did a restart-in-place (exit code 43), the relay fires
            // session_ended when the new worker's registerTuiSession tears down the OLD
            // connection.  The new worker is already live in runningSessions — don't
            // delete its entry and don't touch its attachments.
            if (restartingSessions.has(sessionId)) {
                restartingSessions.delete(sessionId);
                logInfo(`session_ended for ${sessionId} — restarting in place, skipping teardown`);
                return;
            }

            // On relay reconnections the server tears down the old session record
            // before re-registering the same worker.  The worker is still alive —
            // don't delete its runningSessions entry or its attachments.
            if (reason === "Session reconnected") {
                logInfo(`session_ended for ${sessionId} — relay reconnect, skipping teardown`);
                return;
            }

            const entry = runningSessions.get(sessionId);
            let shouldNotifyProviderClose = false;
            if (entry) {
                // If the child process is still alive AND this is a transient
                // relay disconnect (not an expiry/orphan sweep), keep the entry
                // so the worker can reconnect.  For server-initiated cleanup
                // (expired/orphaned), always honor the removal — the session
                // is legitimately dead and the worker should exit on its own.
                const childAlive = entry.child && !entry.child.killed && entry.child.exitCode === null;
                const isTransientDisconnect = !reason || reason === "Session ended";
                if (childAlive && isTransientDisconnect) {
                    logInfo(`session_ended for ${sessionId} but worker still alive — keeping entry for reconnect`);
                    return;
                }
                runningSessions.delete(sessionId);
                killedSessions.delete(sessionId);
                endedSessionIds.set(sessionId, Date.now());
                shouldNotifyProviderClose = true;
                logInfo(`session ${sessionId} ended on relay${entry.adopted ? " (adopted)" : ""}${reason ? ` (${reason})` : ""}`);
            } else if (!endedSessionIds.has(sessionId)) {
                // First duplicate — log once then suppress subsequent copies
                endedSessionIds.set(sessionId, Date.now());
                shouldNotifyProviderClose = true;
                logInfo(`session_ended for unknown/already-removed session ${sessionId}`);
            }
            // else: duplicate session_ended for a session we already handled — silently ignore

            if (shouldNotifyProviderClose) {
                await notifyProviderSessionClose(
                    sessionId,
                    reason,
                    typeof sessionFile === "string" ? sessionFile : entry?.sessionFile,
                );
            }

            cleanupGitSessionState(sessionId);
            if (shouldNotifyProviderClose) sessionCloseMetadata.delete(sessionId);

            // Clean up persisted attachments.  For spawned sessions child.on("exit")
            // already ran cleanup, so this is a no-op (idempotent).  For adopted sessions
            // (child: null) this is the only cleanup path.
            void cleanupSessionAttachments(sessionId).catch(() => {});
        });

        socket.on("list_sessions", () => {
            if (isShuttingDown) return;
            // sessions_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("sessions_list", {
                sessions: Array.from(runningSessions.keys()),
            });
        });


        // ── Daemon control ────────────────────────────────────────────────

        socket.on("restart", () => {
            logInfo("restart request received. Exiting with code 42...");
            setTimeout(() => {
                shutdown(42);
            }, 500);
        });

        socket.on("shutdown", () => {
            logInfo("shutdown request received. Exiting cleanly...");
            setTimeout(() => {
                shutdown(0);
            }, 500);
        });

        socket.on("ping", () => {
            if (isShuttingDown) return;
            // pong is not in the typed protocol yet — emit untyped
            (socket as any).emit("pong", { now: Date.now() });
        });

        // ── Skills management ─────────────────────────────────────────────

        socket.on("list_skills", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skills = scanGlobalSkills();
            socket.emit("skills_list", { skills, requestId });
        });

        socket.on("create_skill", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const skillContent = data.content ?? "";

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeSkill(skillName, skillContent);
                const skills = scanGlobalSkills();
                socket.emit("skill_result", { requestId, ok: true, skills });
            } catch (err) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("update_skill", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const skillContent = data.content ?? "";

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeSkill(skillName, skillContent);
                const skills = scanGlobalSkills();
                socket.emit("skill_result", { requestId, ok: true, skills });
            } catch (err) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("delete_skill", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            const deleted = deleteSkill(skillName);
            const skills = scanGlobalSkills();
            socket.emit("skill_result", {
                requestId,
                ok: deleted,
                message: deleted ? undefined : "Skill not found",
                skills,
            });
        });

        socket.on("get_skill", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const content = skillName ? readSkillContent(skillName) : null;
            if (content === null) {
                socket.emit("skill_result", { requestId, ok: false, message: "Skill not found" });
            } else {
                socket.emit("skill_result", { requestId, ok: true, name: skillName, content });
            }
        });

        // ── Agents management ──────────────────────────────────────────────

        socket.on("list_agents", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agents = scanGlobalAgents();
            socket.emit("agents_list", { agents, requestId });
        });

        socket.on("create_agent", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();
            const agentContent = data.content ?? "";

            if (!agentName) {
                socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(agentName) && !/^[a-z0-9]$/.test(agentName)) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: "Invalid agent name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeAgent(agentName, agentContent);
                const agents = scanGlobalAgents();
                socket.emit("agent_result", { requestId, ok: true, agents });
            } catch (err) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("update_agent", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();
            const agentContent = data.content ?? "";

            if (!agentName) {
                socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
                return;
            }

            // Relaxed validation for updates: accept any name the scanner
            // can discover (letters, digits, hyphens, underscores, dots)
            // but reject path separators to prevent directory traversal.
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentName)) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: "Invalid agent name: must start with a letter or digit and contain only letters, digits, hyphens, underscores, or dots",
                });
                return;
            }

            try {
                await writeAgent(agentName, agentContent);
                const agents = scanGlobalAgents();
                socket.emit("agent_result", { requestId, ok: true, agents });
            } catch (err) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("delete_agent", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();

            if (!agentName) {
                socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
                return;
            }

            const deleted = deleteAgent(agentName);
            const agents = scanGlobalAgents();
            socket.emit("agent_result", {
                requestId,
                ok: deleted,
                message: deleted ? undefined : "Agent not found",
                agents,
            });
        });

        socket.on("get_agent", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();
            const content = agentName ? readAgentContent(agentName) : null;
            if (content === null) {
                socket.emit("agent_result", { requestId, ok: false, message: "Agent not found" });
            } else {
                socket.emit("agent_result", { requestId, ok: true, name: agentName, content });
            }
        });

        // ── Plugins management ─────────────────────────────────────────────

        socket.on("list_plugins", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            // Use the provided cwd (e.g. session's working directory) if
            // available, otherwise fall back to the daemon's own cwd.
            // Validate against workspace roots to prevent arbitrary path scanning.
            const rawCwd = (typeof data?.cwd === "string" && data.cwd) ? data.cwd : undefined;
            if (rawCwd && !isCwdAllowed(rawCwd)) {
                socket.emit("plugins_list", { plugins: [], requestId, ok: false, message: "cwd outside allowed workspace roots" });
                return;
            }
            // Only include project-local plugins when an explicit session cwd
            // was provided AND it's within allowed workspace roots. Without an
            // explicit cwd this is a runner-level query — only global plugins.
            // When rawCwd is absent, pass undefined so marketplace discovery
            // skips project-scoped plugins and respects only user-level settings.
            const scanCwd = rawCwd ?? undefined;
            const includeLocal = !!rawCwd && isCwdAllowed(rawCwd);
            const plugins = scanAllPluginInfo(scanCwd, { includeProjectLocal: includeLocal });
            // Echo scoped flag so the server can skip cache updates for per-session scans
            socket.emit("plugins_list", { plugins, requestId, ...(rawCwd ? { scoped: true } : {}) });
        });

        // ── Sandbox ────────────────────────────────────────────────────────

        socket.on("sandbox_get_status", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            try {
                // Read sandbox config from disk — the daemon process does NOT
                // run inside a sandbox itself, so process-local sandbox state
                // (getSandboxMode, isSandboxActive, getViolations) would always
                // return defaults.  The persisted config is the source of truth
                // for what workers will use.
                const { loadConfig, resolveSandboxConfig, loadGlobalConfig } = await import("../config.js");
                // Use only the global config for resolution — the daemon
                // process CWD may contain project-local overrides that
                // should not influence the global settings editor.
                const globalCfg = loadGlobalConfig();
                const globalOnlyConfig = loadConfig(process.cwd());
                // Override sandbox with global-only to prevent project-local
                // settings from leaking into the status response.
                globalOnlyConfig.sandbox = globalCfg.sandbox ?? {};
                const resolvedConfig = resolveSandboxConfig(process.cwd(), globalOnlyConfig);
                const mode = resolvedConfig.mode ?? "none";
                // The daemon can't know if a worker sandbox is actively
                // enforcing right now — report that a non-"none" mode is
                // *configured*, not that enforcement is proven active.
                const configured = mode !== "none";
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    mode,
                    active: configured,
                    configured,
                    platform: process.platform,
                    violations: 0,
                    recentViolations: [],
                    config: resolvedConfig,
                    // Send only the *global* raw config so the UI editor
                    // doesn't leak project-local overrides into global config
                    // when saving.
                    rawConfig: loadGlobalConfig().sandbox ?? {},
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("sandbox_update_config", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const body = data.config;
            try {
                if (!body || typeof body !== "object") {
                    socket.emit("file_result", { requestId, ok: false, message: "Invalid sandbox config body" });
                    return;
                }
                const validModes = ["none", "basic", "full"];
                if (body.mode !== undefined && !validModes.includes(body.mode)) {
                    socket.emit("file_result", { requestId, ok: false, message: `Invalid mode "${body.mode}"` });
                    return;
                }
                const { saveGlobalConfig, loadConfig, resolveSandboxConfig, loadGlobalConfig } = await import("../config.js");
                // Merge with existing global sandbox config so UI-unmanaged
                // fields (ignoreViolations, allowUnixSockets, proxy ports,
                // allowGitConfig, etc.) are preserved across saves.
                const existingSandbox = loadGlobalConfig().sandbox ?? {} as Record<string, any>;
                // Deep-merge nested objects (filesystem, network) so that
                // sub-fields not managed by the UI (e.g. allowGitConfig,
                // allowUnixSockets, proxy ports) are preserved.
                const merged: Record<string, any> = { ...existingSandbox };
                for (const [key, value] of Object.entries(body)) {
                    if (value && typeof value === "object" && !Array.isArray(value)
                        && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
                        merged[key] = { ...merged[key], ...value };
                    } else {
                        merged[key] = value;
                    }
                }
                saveGlobalConfig({ sandbox: merged });
                const newConfig = loadConfig(process.cwd());
                const resolved = resolveSandboxConfig(process.cwd(), newConfig);
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    saved: true,
                    resolvedConfig: resolved,
                    message: "Changes will apply on next session start.",
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Usage dashboard ───────────────────────────────────────────────

        // ── Models ──────────────────────────────────────────────────────

        socket.on("list_models", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            try {
                const models = listConfiguredModels(process.cwd());
                socket.emit("models_list", { requestId, models });
            } catch (e: any) {
                socket.emit("models_list", { requestId, models: [], error: e.message ?? "Failed to list models" });
            }
        });

        // ── Usage ─────────────────────────────────────────────────────────

        socket.on("get_usage", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId ?? "";
            try {
                const range = (data.range as UsageRange) || "90d";
                const usageData = getUsageData(range);
                if (!usageData) {
                    socket.emit("usage_error", {
                        requestId,
                        error: "Usage data not available yet — initial scan in progress",
                    });
                    return;
                }
                socket.emit("usage_data", { requestId, data: usageData });
            } catch (e: any) {
                socket.emit("usage_error", {
                    requestId,
                    error: e.message ?? "Unknown error",
                });
            }
        });

        // ── Session Analysis ──────────────────────────────────────────

        socket.on("analyze_session", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId ?? "";
            try {
                const sessionId = data.sessionId;
                if (!sessionId || typeof sessionId !== "string") {
                    socket.emit("analyze_session_error", {
                        requestId,
                        error: "Missing sessionId parameter",
                    });
                    return;
                }
                const sessionMetadata = sessionCloseMetadata.get(sessionId);
                const sessionsRootDir = join(resolveConfiguredAgentDir(sessionMetadata?.cwd), "sessions");
                const sessionFile = runningSessions.get(sessionId)?.sessionFile
                    ?? sessionMetadata?.sessionFile
                    ?? await findSessionPathById(sessionsRootDir, sessionId);
                if (!sessionFile) {
                    socket.emit("analyze_session_error", {
                        requestId,
                        error: "Session file not found for " + sessionId,
                    });
                    return;
                }
                const MAX_ANALYSIS_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
                const transcriptFile = Bun.file(sessionFile);
                if (!await transcriptFile.exists()) {
                    socket.emit("analyze_session_error", {
                        requestId,
                        error: "Session file does not exist: " + sessionFile,
                    });
                    return;
                }
                if (transcriptFile.size > MAX_ANALYSIS_FILE_SIZE) {
                    socket.emit("analyze_session_error", {
                        requestId,
                        error: `Session file too large for analysis (${Math.round(transcriptFile.size / 1024 / 1024)} MB, max ${MAX_ANALYSIS_FILE_SIZE / 1024 / 1024} MB)`,
                    });
                    return;
                }
                const { parseJsonlEntries } = await import("../session-analysis/parser.js");
                const { reconstructContext } = await import("../session-analysis/analyzer.js");
                const content = await transcriptFile.text();
                const { entries } = parseJsonlEntries(content);
                const leafId = entries.findLast((e: any) => e.id)?.id ?? "root";
                const analysis = reconstructContext(
                    entries,
                    leafId,
                    getContextWindowsForAnalysis(sessionMetadata?.cwd),
                );
                socket.emit("analyze_session_data", { requestId, data: analysis });
            } catch (e: any) {
                socket.emit("analyze_session_error", {
                    requestId,
                    error: e.message ?? "Unknown error",
                });
            }
        });

        // ── Settings ───────────────────────────────────────────────────────

        // sanitizeConfigForUI is imported from ./daemon-config-sanitize.js

        socket.on("settings_get_config", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            try {
                const { loadGlobalConfig: loadGlobal } = await import("../config.js");
                const globalConfig = loadGlobal();

                // Also read settings.json (TUI preferences)
                const settingsPath = join(homedir(), ".pizzapi", "settings.json");
                let tuiSettings: Record<string, unknown> = {};
                try {
                    const { readFileSync, existsSync } = await import("fs");
                    if (existsSync(settingsPath)) {
                        tuiSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
                    }
                } catch {
                    // settings.json may not exist yet
                }

                // Also read ~/.pizzapi/AGENTS.md
                const agentsMdPath = join(homedir(), ".pizzapi", "AGENTS.md");
                let agentsMd = "";
                try {
                    const { readFileSync, existsSync } = await import("fs");
                    if (existsSync(agentsMdPath)) {
                        agentsMd = readFileSync(agentsMdPath, "utf-8");
                    }
                } catch {
                    // AGENTS.md may not exist yet
                }

                // Strip sensitive fields before sending to UI
                const sanitizedConfig = sanitizeConfigForUI(globalConfig as Record<string, unknown>);
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    config: sanitizedConfig,
                    tuiSettings,
                    agentsMd,
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("settings_update_section", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            const section = data?.section;
            const value = data?.value;
            try {
                if (!section || typeof section !== "string") {
                    socket.emit("file_result", { requestId, ok: false, message: "Missing section name" });
                    return;
                }

                // Handle AGENTS.md separately — it's a standalone file, not JSON config
                if (section === "agentsMd") {
                    const agentsMdPath = join(homedir(), ".pizzapi", "AGENTS.md");
                    const { writeFileSync, chmodSync: chmodSyncAgents, mkdirSync, existsSync } = await import("fs");
                    const dir = join(homedir(), ".pizzapi");
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
                    const content = typeof value === "string" ? value : "";
                    writeFileSync(agentsMdPath, content, { encoding: "utf-8", mode: 0o600 });
                    chmodSyncAgents(agentsMdPath, 0o600); // tighten permissions on pre-existing files
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        saved: true,
                        message: "AGENTS.md saved. Changes apply on next session start.",
                    });
                    return;
                }

                // Sections that go into settings.json (TUI preferences)
                const tuiSections = new Set(["tuiPreferences", "models"]);

                if (tuiSections.has(section)) {
                    // Read/merge/write settings.json
                    const settingsPath = join(homedir(), ".pizzapi", "settings.json");
                    const { readFileSync, writeFileSync, chmodSync: chmodSyncSettings, existsSync, mkdirSync } = await import("fs");
                    const dir = join(homedir(), ".pizzapi");
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
                    let existing: Record<string, unknown> = {};
                    try {
                        if (existsSync(settingsPath)) {
                            existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
                        }
                    } catch { /* start fresh */ }

                    // Merge TUI settings at top level
                    if (value && typeof value === "object" && !Array.isArray(value)) {
                        Object.assign(existing, value);
                    }
                    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), { encoding: "utf-8", mode: 0o600 });
                    chmodSyncSettings(settingsPath, 0o600); // tighten permissions on pre-existing files
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        saved: true,
                        message: "TUI settings saved. Changes apply on next session start.",
                    });
                } else {
                    // All other sections go into config.json
                    const { saveGlobalConfig: saveGlobal, loadGlobalConfig: loadGlobal } = await import("../config.js");

                    // Map section names to config.json keys
                    const sectionToConfigKey: Record<string, string> = {
                        mcpServers: "mcpServers",
                        hooks: "hooks",
                        sandbox: "sandbox",
                        webSearch: "providerSettings",
                        toolSearch: "toolSearch",
                        security: "_security",        // virtual — handled specially
                        envVars: "_envVars",          // virtual — handled specially
                        systemPrompt: "_systemPrompt", // virtual — handled specially
                    };

                    const configKey = sectionToConfigKey[section] ?? section;
                    const existing = loadGlobal();

                    if (section === "security") {
                        const v = value as any;
                        const updates: Record<string, any> = {};
                        if (v?.allowProjectHooks !== undefined) updates.allowProjectHooks = v.allowProjectHooks;
                        if (v?.trustedPlugins !== undefined) updates.trustedPlugins = v.trustedPlugins;
                        saveGlobal(updates);
                    } else if (section === "systemPrompt") {
                        const v = value as any;
                        const updates: Record<string, any> = {};
                        if (v?.appendSystemPrompt !== undefined) updates.appendSystemPrompt = v.appendSystemPrompt;
                        if (v?.builtinSystemPrompt !== undefined) updates.builtinSystemPrompt = v.builtinSystemPrompt;
                        if (v?.sendAgentsMd !== undefined) updates.sendAgentsMd = v.sendAgentsMd;
                        if (v?.skills !== undefined) updates.skills = v.skills;
                        saveGlobal(updates);
                    } else if (section === "envVars") {
                        // Env vars are stored in a custom key in config.json.
                        // Restore any masked ("***") sentinel values from the on-disk config
                        // so we don't overwrite real secrets with the placeholder.
                        const MASK_SENTINEL = "***";
                        const existingOverrides = ((existing as any).envOverrides ?? {}) as Record<string, string>;
                        const incomingOverrides = (value ?? {}) as Record<string, string>;
                        const restoredOverrides: Record<string, string> = { ...incomingOverrides };
                        for (const [k, v] of Object.entries(incomingOverrides)) {
                            if (v === MASK_SENTINEL && typeof existingOverrides[k] === "string") {
                                restoredOverrides[k] = existingOverrides[k];
                            }
                        }
                        const updates: Record<string, any> = { envOverrides: restoredOverrides };
                        saveGlobal(updates);
                    } else if (section === "providerOverrides") {
                        // Per-provider overrides (system prompt, AGENTS.md, MCP disable
                        // list) go into providerSettings.<provider>.overrides.
                        const validationErrors = validateProviderOverridesSection(value);
                        if (validationErrors.length > 0) {
                            socket.emit("file_result", {
                                requestId,
                                ok: false,
                                message: `Invalid provider overrides:\n${validationErrors.join("\n")}`,
                            });
                            return;
                        }
                        const ps = mergeProviderOverridesSection(
                            (existing as any).providerSettings,
                            (value ?? {}) as Record<string, unknown>,
                        );
                        saveGlobal({ providerSettings: ps } as any);
                    } else if (section === "webSearch") {
                        // Web search config goes into providerSettings
                        const v = value as any;
                        const ps = (existing as any).providerSettings ?? {};
                        if (v?.anthropic?.webSearch) {
                            ps.anthropic = { ...ps.anthropic, webSearch: v.anthropic.webSearch };
                        }
                        if (v?.["ollama-cloud"]?.webSearch) {
                            ps["ollama-cloud"] = { ...ps["ollama-cloud"], webSearch: v["ollama-cloud"].webSearch };
                        }
                        saveGlobal({ providerSettings: ps } as any);
                    } else if (section === "toolSearch") {
                        if (value != null && (typeof value !== "object" || Array.isArray(value))) {
                            socket.emit("file_result", {
                                requestId,
                                ok: false,
                                message: "toolSearch must be a JSON object",
                            });
                            return;
                        }

                        const toolSearch = (value ?? {}) as Record<string, unknown>;
                        const errors: string[] = [];
                        const enabled = toolSearch.enabled;
                        const tokenThreshold = toolSearch.tokenThreshold;
                        const maxResults = toolSearch.maxResults;
                        const keepLoadedTools = toolSearch.keepLoadedTools;

                        if (enabled !== undefined && typeof enabled !== "boolean") {
                            errors.push('"enabled" must be a boolean');
                        }
                        if (
                            tokenThreshold !== undefined &&
                            (typeof tokenThreshold !== "number" || !Number.isFinite(tokenThreshold) || tokenThreshold < 0)
                        ) {
                            errors.push('"tokenThreshold" must be a finite number >= 0');
                        }
                        if (
                            maxResults !== undefined &&
                            (typeof maxResults !== "number" || !Number.isFinite(maxResults) || maxResults < 1)
                        ) {
                            errors.push('"maxResults" must be a finite number >= 1');
                        }
                        if (keepLoadedTools !== undefined && typeof keepLoadedTools !== "boolean") {
                            errors.push('"keepLoadedTools" must be a boolean');
                        }
                        if (errors.length > 0) {
                            socket.emit("file_result", {
                                requestId,
                                ok: false,
                                message: `Invalid Tool Search config:\n${errors.join("\n")}`,
                            });
                            return;
                        }

                        saveGlobal({ toolSearch: value as any });
                    } else if (section === "mcpServers") {
                        // Validate MCP server config before saving
                        if (value != null && (typeof value !== "object" || Array.isArray(value))) {
                            socket.emit("file_result", {
                                requestId,
                                ok: false,
                                message: "mcpServers must be a JSON object (Record<string, ServerEntry>)",
                            });
                            return;
                        }
                        const servers = (value ?? {}) as Record<string, any>;
                        const errors: string[] = [];
                        for (const [name, entry] of Object.entries(servers)) {
                            if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
                                errors.push(`"${name}": must be an object`);
                                continue;
                            }
                            const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
                            const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
                            if (!hasCommand && !hasUrl) {
                                errors.push(`"${name}": must have a "command" (stdio) or "url" (http) field`);
                            }
                        }
                        if (errors.length > 0) {
                            socket.emit("file_result", {
                                requestId,
                                ok: false,
                                message: `Invalid MCP server config:\n${errors.join("\n")}`,
                            });
                            return;
                        }

                        // The settings API masks sensitive env var and header values (e.g. tokens/keys)
                        // with MASK_SENTINEL ("***") before sending them to the UI so they aren't
                        // exposed in transit.  When the UI sends the config back on save, those
                        // masked values must NOT be written to disk — restoreMaskedServerEntry()
                        // substitutes the original on-disk secret for each key still carrying the
                        // sentinel.
                        //
                        // Renames are handled heuristically by findRenamedServerMatch() below:
                        // when an incoming entry has masked secrets but no on-disk entry under its
                        // name, we look for a deleted entry whose env/header keys would supply the
                        // sentinels.  This survives the user editing command/url/args in the same
                        // save.  Truly ambiguous cases (multiple plausible renames) still fall back
                        // to writing the sentinel — visible and recoverable.
                        const existingMcpServers = ((existing as any).mcpServers ?? {}) as Record<string, any>;

                        // Identify deleted servers to heuristically match renames
                        const incomingNames = new Set(Object.keys(servers));
                        const deletedServers = Object.entries(existingMcpServers)
                            .filter(([name]) => !incomingNames.has(name))
                            .map(([_name, srv]) => srv)
                            .filter((srv) => srv && typeof srv === "object");

                        const mergedServers: Record<string, any> = {};
                        for (const [name, entry] of Object.entries(servers)) {
                            if (entry && typeof entry === "object") {
                                let existingEntry = existingMcpServers[name];
                                if (!existingEntry) {
                                    existingEntry = findRenamedServerMatch(entry as Record<string, unknown>, deletedServers);
                                }

                                mergedServers[name] = restoreMaskedServerEntry(
                                    entry as Record<string, unknown>,
                                    existingEntry,
                                );
                            } else {
                                mergedServers[name] = entry;
                            }
                        }
                        saveGlobal({ mcpServers: mergedServers } as any);
                    } else if (section === "mcp") {
                        // mcp.servers[] (preferred array format) — restore masked sentinel values
                        // before writing to disk.  We look up each server by its `name` field in
                        // the on-disk array so we can restore the original secret.
                        //
                        // Renames in the array format are likewise resolved via
                        // findRenamedServerMatch() against deleted entries.
                        const incomingMcp = (value ?? {}) as { servers?: any[] };
                        const existingMcp = ((existing as any).mcp ?? {}) as { servers?: any[] };

                        // Build name → entry map for O(1) lookup against the on-disk array.
                        const existingByName = new Map<string, Record<string, unknown>>();
                        if (Array.isArray(existingMcp.servers)) {
                            for (const s of existingMcp.servers) {
                                if (s && typeof s === "object" && typeof (s as any).name === "string") {
                                    existingByName.set((s as any).name as string, s as Record<string, unknown>);
                                }
                            }
                        }

                        // Identify deleted servers to heuristically match renames
                        const incomingNamesArray = new Set(
                            Array.isArray(incomingMcp.servers)
                                ? incomingMcp.servers
                                      .map((s: any) => s && typeof s === "object" ? s.name : undefined)
                                      .filter((n): n is string => typeof n === "string")
                                : []
                        );

                        const deletedServersArray: Record<string, unknown>[] = [];
                        if (Array.isArray(existingMcp.servers)) {
                            for (const srv of existingMcp.servers) {
                                if (srv && typeof srv === "object" && typeof (srv as any).name === "string") {
                                    if (!incomingNamesArray.has((srv as any).name)) {
                                        deletedServersArray.push(srv as Record<string, unknown>);
                                    }
                                }
                            }
                        }

                        const mergedMcpServers: any[] = Array.isArray(incomingMcp.servers)
                            ? incomingMcp.servers.map((entry: any) => {
                                  if (!entry || typeof entry !== "object") return entry;

                                  let existingEntry: Record<string, unknown> | undefined = undefined;
                                  if (typeof entry.name === "string") {
                                      existingEntry = existingByName.get(entry.name);
                                      if (!existingEntry) {
                                          existingEntry = findRenamedServerMatch(entry as Record<string, unknown>, deletedServersArray);
                                      }
                                  }

                                  return restoreMaskedServerEntry(
                                      entry as Record<string, unknown>,
                                      existingEntry,
                                  );
                              })
                            : [];

                        saveGlobal({ mcp: { ...incomingMcp, servers: mergedMcpServers } } as any);
                    } else {
                        // Direct key mapping
                        saveGlobal({ [configKey]: value } as any);
                    }

                    // Reload and return the updated config — mask secrets before sending to browser
                    const updatedConfig = sanitizeConfigForUI(loadGlobal() as Record<string, unknown>);
                    const isMcpSection = section === "mcpServers" || section === "mcp" || section === "toolSearch";
                    const reloadHint = isMcpSection
                        ? "MCP server config saved. Active sessions can run /mcp reload to pick up changes."
                        : "Settings saved. Changes apply on next session start.";
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        saved: true,
                        config: updatedConfig,
                        message: reloadHint,
                        reloadHint: isMcpSection,
                    });
                }
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Package management ────────────────────────────────────────────────

        async function withPackageManager<T extends Record<string, unknown>>(
            socket: any,
            requestId: string,
            fn: (pm: any) => Promise<T>,
        ): Promise<void> {
            try {
                const { DefaultPackageManager, SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
                const agentDir = getAgentDir();
                const cwd = process.cwd();
                const settingsManager = SettingsManager.create(cwd, agentDir);
                const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
                const result = await fn(packageManager);
                socket.emit("file_result", { requestId, ok: true, ...result });
            } catch (err) {
                socket.emit("file_result", { requestId, ok: false, message: err instanceof Error ? err.message : String(err) });
            }
        }

        socket.on("packages_list", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            await withPackageManager(socket, requestId, async (packageManager) => {
                const packages = packageManager.listConfiguredPackages();
                return { packages, message: `Found ${packages.length} package(s)` };
            });
        });

        socket.on("packages_install", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            const source = data?.source;
            const isLocal = data?.local === true;

            if (!source || typeof source !== "string") {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: "Missing or invalid package source",
                });
                return;
            }

            await withPackageManager(socket, requestId, async (packageManager) => {
                await packageManager.install(source, { local: isLocal });
                const added = packageManager.addSourceToSettings(source, { local: isLocal });
                if (!added) {
                    throw new Error(`Failed to add package ${source} to settings`);
                }
                return { message: `Package ${source} installed successfully` };
            });
        });

        socket.on("packages_remove", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            const source = data?.source;
            const isLocal = data?.local === true;

            if (!source || typeof source !== "string") {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: "Missing or invalid package source",
                });
                return;
            }

            await withPackageManager(socket, requestId, async (packageManager) => {
                await packageManager.remove(source, { local: isLocal });
                const removed = packageManager.removeSourceFromSettings(source, { local: isLocal });
                if (!removed) {
                    throw new Error(`Package ${source} not found in settings`);
                }
                return { message: `Package ${source} removed successfully` };
            });
        });

        socket.on("packages_update", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            const source = data?.source; // Optional: update specific package

            await withPackageManager(socket, requestId, async (packageManager) => {
                await packageManager.update(source);
                return {
                    message: source
                        ? `Package ${source} updated successfully`
                        : "All packages updated successfully",
                };
            });
        });

        // ── Error handling ────────────────────────────────────────────────

        socket.on("error", (data: any) => {
            logError(`server error: ${data.message}`);
        });
    });
}
