import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { ServiceRegistry } from "./service-handler.js";
import { TerminalService } from "./services/terminal-service.js";
import { FileExplorerService } from "./services/file-explorer-service.js";
import { GitService } from "./services/git-service.js";
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
import { loadGlobalConfig, defaultAgentDir, expandHome, loadConfig } from "../config.js";
import { findSessionPathById } from "./session-list-cache.js";
import { cleanupSessionAttachments, sweepOrphanedAttachments } from "../extensions/session-attachments.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ServiceTriggerDef, ServiceSigilDef, TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { setLogComponent, logInfo, logWarn, logError } from "./logger.js";
import { extractHookSummary } from "./hook-summary.js";
import { sanitizeConfigForUI, restoreMaskedServerEntry, MASK_SENTINEL } from "./daemon-config-sanitize.js";
import { defaultStatePath, acquireStateAndIdentity, releaseStateLock } from "./runner-state.js";
import { startUsageRefreshLoop, stopUsageRefreshLoop } from "./runner-usage-cache.js";
import { syncKeychainToAuthJsonFile } from "./keychain-auth.js";
import { getWorkspaceRoots, isCwdAllowed } from "./workspace.js";
import { type RunnerSession, spawnSession } from "./session-spawner.js";

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

    // ── Keychain → auth.json sync (macOS only) ────────────────────────────
    // Claude Code refreshes its OAuth token independently and stores it in the
    // macOS Keychain.  Periodically check if the Keychain copy is fresher and
    // update auth.json so all workers benefit without their own Keychain reads.
    const keychainAuthJsonPath = join(defaultAgentDir(), "auth.json");
    // Immediate sync on daemon boot
    try { syncKeychainToAuthJsonFile(keychainAuthJsonPath); } catch {}
    const keychainSyncInterval = setInterval(() => {
        try { syncKeychainToAuthJsonFile(keychainAuthJsonPath); } catch {}
    }, 2 * 60 * 1000); // every 2 minutes

    // Load global config so relayUrl and apiKey can be read from
    // ~/.pizzapi/config.json (important for LaunchAgent contexts where
    // env vars aren't available).
    const daemonConfig = loadGlobalConfig();

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
        const relayRaw = (process.env.PIZZAPI_RELAY_URL ?? resolveConfigRelayUrl() ?? "ws://localhost:7492")
            .trim()
            .replace(/\/$/, "");

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
        let servicesInitialized = false;

        // ── Service registry ──────────────────────────────────────────────
        const registry = new ServiceRegistry();
        registry.register(new TerminalService());
        registry.register(new FileExplorerService());
        registry.register(new GitService());
        const cleanupGitSessionState = (sessionId: string) => {
            const gitService = registry.get("git");
            if (!gitService) return;
            const maybeGitService = gitService as GitService & { handleSessionEnded?: (id: string) => void };
            maybeGitService.handleSessionEnded?.(sessionId);
        };
        const tunnelService = new TunnelService();
        registry.register(tunnelService);
        const timeService = new TimeService();
        registry.register(timeService);

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
        };
        const panelEntries = new Map<string, PanelEntry>();

        // Register built-in Time service trigger/sigil defs so they flow through service_announce.
        // The Time service has no panel — it only runs an HTTP server for sigil resolve calls.
        // Trigger/sigil defs are tracked via panelEntries (no port here) so they appear in
        // service_announce. The resolve port is tracked separately in sigilServerPorts and
        // stamped onto the sigil defs at announce time.
        panelEntries.set("time", {
            serviceId: "time",
            label: "Time",
            icon: "clock",
            hasPanel: false,
            triggers: TIME_TRIGGER_DEFS,
            sigils: TIME_SIGIL_DEFS,
        });

        // Ports for services that run an HTTP resolve server but have no UI panel.
        // Keyed by serviceId. Populated when the service calls announceSigilServer().
        const sigilServerPorts = new Map<string, number>();

        /** Emit service_announce with current service IDs, panel metadata, and trigger defs. */
        const emitServiceAnnounce = () => {
            const allServiceIds = registry.getAll().map((s) => s.id);
            const panels = Array.from(panelEntries.values())
                .filter((p): p is PanelEntry & { port: number } => p.port != null && p.hasPanel !== false);
            // Collect all trigger defs and sigil defs across all services with manifests
            const allTriggerDefs: ServiceTriggerDef[] = [];
            const allSigilDefs: ServiceSigilDef[] = [];
            for (const entry of panelEntries.values()) {
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
        discoverServices({ pluginDirs: globalPluginDirs() }).then(({ services, errors }) => {
            for (const { handler, source, manifest } of services) {
                try {
                    registry.register(handler);
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

        const shutdown = (code: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            clearInterval(endedSessionSweep);
            clearInterval(usageScanInterval);
            clearInterval(keychainSyncInterval);
            tunnelClient?.dispose();
            registry.disposeAll();
            stopUsageRefreshLoop();
            closeUsage();
            releaseStateLock(statePath);
            socket.disconnect();
            resolve(code);
        };

        process.on("SIGINT", () => shutdown(0));
        process.on("SIGTERM", () => shutdown(0));

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

        socket.on("disconnect", (reason) => {
            if (isShuttingDown) return;
            logInfo(`disconnected (${reason}). Socket.IO will reconnect automatically.`);
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
                // (built-in + plugins) and announce the full list.
                // On reconnect, dispose first to clear stale listeners from the old socket.
                await pluginServicesReady;
                if (servicesInitialized) {
                    registry.disposeAll();
                }
                servicesInitialized = true;
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

                // Init all services — pass announcePanel to those with a UI panel,
                // announceSigilServer to panel-less services that only need HTTP resolve routing.
                for (const handler of registry.getAll()) {
                    const opts: any = { isShuttingDown: () => isShuttingDown };
                    const entry = panelEntries.get(handler.id);
                    if (entry) {
                        if (entry.hasPanel !== false) {
                            opts.announcePanel = announcePanel(handler.id);
                        } else {
                            opts.announceSigilServer = announceSigilServer(handler.id);
                        }
                    }
                    handler.init(socket, opts);
                }
                const allServiceIds = registry.getAll().map((s) => s.id);
                logInfo(`[services] initialized ${allServiceIds.length} services: ${allServiceIds.join(", ")}`);

                // TunnelService now preserves its exposed-port state across Socket.IO
                // reconnects and re-announces known ports when re-initialized.
                emitServiceAnnounce();

                // Re-adopt orphaned sessions that survived a daemon restart.
                // Their worker processes are still running and connected to the relay.
                const existingSessions = data.existingSessions ?? [];
                if (existingSessions.length > 0) {
                    let adopted = 0;
                    for (const { sessionId, cwd } of existingSessions) {
                        if (runningSessions.has(sessionId)) continue; // already tracked
                        runningSessions.set(sessionId, {
                            sessionId,
                            child: null,
                            startedAt: Date.now(),
                            adopted: true,
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

                const { applied: totalApplied, errors: allErrors } = reconcileSnapshotSubscriptions(registry, subscriptions);

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

                const prefix = subscription.triggerType.split(":")[0];
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
                        const result = service.reconcileSubscriptions([subscription], {
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
                const sessionsRootDir = join(defaultAgentDir(), "agent", "sessions");
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

        socket.on("kill_session", (data: any) => {
            if (isShuttingDown) return;
            const { sessionId } = data;
            const entry = runningSessions.get(sessionId);
            if (entry) {
                if (entry.child) {
                    try {
                        // Mark as killed BEFORE sending SIGTERM so the child's
                        // exit handler sees it even if exit code 43 (restart-in-place)
                        // arrives before SIGTERM is delivered.
                        killedSessions.add(sessionId);
                        entry.child.kill("SIGTERM");
                    } catch {}
                } else if (entry.adopted) {
                    // No child handle — ask the relay to disconnect the worker's
                    // socket, which sends end_session then force-disconnects.
                    socket.emit("disconnect_session", { sessionId });
                }
                runningSessions.delete(sessionId);
                cleanupGitSessionState(sessionId);
                logInfo(`killed session ${sessionId}${entry.adopted ? " (adopted)" : ""}`);
                socket.emit("session_killed", { sessionId });
                // Clean up persisted attachments for this session
                void cleanupSessionAttachments(sessionId).catch(() => {});
            }
        });

        // ── session_ended — relay notifies us a worker disconnected ───────
        socket.on("session_ended", (data: any) => {
            if (isShuttingDown) return;
            const { sessionId, reason } = data;

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
                logInfo(`session ${sessionId} ended on relay${entry.adopted ? " (adopted)" : ""}${reason ? ` (${reason})` : ""}`);
            } else if (!endedSessionIds.has(sessionId)) {
                // First duplicate — log once then suppress subsequent copies
                endedSessionIds.set(sessionId, Date.now());
                logInfo(`session_ended for unknown/already-removed session ${sessionId}`);
            }
            // else: duplicate session_ended for a session we already handled — silently ignore

            cleanupGitSessionState(sessionId);

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
                const config = loadConfig(process.cwd());
                const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
                const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
                const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
                const models = modelRegistry
                    .getAvailable()
                    .map((model: any) => ({
                        provider: model.provider,
                        id: model.id,
                        name: model.name,
                        reasoning: model.reasoning,
                        contextWindow: model.contextWindow,
                    }))
                    .sort((a: any, b: any) => {
                        if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                        return a.id.localeCompare(b.id);
                    });
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
                        if (v?.skills !== undefined) updates.skills = v.skills;
                        if (v?.claudeCodeProvider !== undefined) updates.claudeCodeProvider = v.claudeCodeProvider;
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
                    } else if (section === "webSearch") {
                        // Web search config goes into providerSettings
                        const v = value as any;
                        const ps = (existing as any).providerSettings ?? {};
                        if (v?.anthropic?.webSearch) {
                            ps.anthropic = { ...ps.anthropic, webSearch: v.anthropic.webSearch };
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
                        // TODO(P2): Rename edge case -- if an MCP server is renamed in the UI
                        // before saving, the masked "***" values can't be matched to the old
                        // on-disk entry (key lookup by new name finds no existing server).
                        // Those entries will be written as literal "***", which the user will
                        // notice as obviously broken credentials.  A full fix requires tracking
                        // server identity across renames (e.g. a stable ID field or a diff
                        // protocol).  For now the failure is visible and recoverable by the user.
                        const existingMcpServers = ((existing as any).mcpServers ?? {}) as Record<string, any>;
                        const mergedServers: Record<string, any> = {};
                        for (const [name, entry] of Object.entries(servers)) {
                            if (entry && typeof entry === "object") {
                                mergedServers[name] = restoreMaskedServerEntry(
                                    entry as Record<string, unknown>,
                                    existingMcpServers[name],
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
                        // TODO(P2): Same rename edge case as mcpServers — if a server's name is
                        // changed in the UI the lookup by name will find nothing and the sentinel
                        // will be written as-is.  Visible and recoverable by the user.
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

                        const mergedMcpServers: any[] = Array.isArray(incomingMcp.servers)
                            ? incomingMcp.servers.map((entry: any) => {
                                  if (!entry || typeof entry !== "object") return entry;
                                  const existingEntry =
                                      typeof entry.name === "string"
                                          ? existingByName.get(entry.name)
                                          : undefined;
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

        // ── Error handling ────────────────────────────────────────────────

        socket.on("error", (data: any) => {
            logError(`server error: ${data.message}`);
        });
    });
}
