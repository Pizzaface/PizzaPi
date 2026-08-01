import { exec, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { forceKillTree, isShutdownMessage, requestChildShutdown, STOP_FILE_NAME } from "./process-kill.js";
import { ServiceRegistry, type ServiceHandler, type ServiceInitOptions } from "./service-handler.js";
import type { PizzaPiSocket } from "@pizzapi/extension-sdk";
import { TerminalService } from "./services/terminal-service.js";
import { FileExplorerService } from "./services/file-explorer-service.js";
import { GitService, GIT_SIGIL_DEFS } from "./services/git-service.js";
// Resolves @VARIABLE@ tokens used in service panel requires
import { resolvePizzaPiVar } from "../config/io.js";
import { mergeModelLists, readSessionModelsCache, type SessionModelEntry } from "../session-models-cache.js";
import { getCachedOllamaCloudModels, registerOllamaCloudProvider } from "../ollama-cloud-models.js";
import { TunnelService } from "./services/tunnel-service.js";
import { ProcessService } from "./services/process-service.js";
import { MemoryService } from "./services/memory-service.js";
import { TimeService, TIME_TRIGGER_DEFS, TIME_SIGIL_DEFS } from "./services/time-service.js";
import { discoverServices } from "./service-loader.js";
import type { ServiceManifest, ServicePluginResult } from "./service-loader.js";
import { discoverPackageServices, type DiscoverPackageServicesResult } from "./package-service-loader.js";
import { BUILTIN_SERVICE_IDS, NON_DISABLEABLE_SERVICE_IDS } from "./services/builtin-service-ids.js";
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
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServiceTriggerDef, ServiceSigilDef, TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { setLogComponent, logInfo, logWarn, logError } from "./logger.js";
import { extractHookSummary } from "./hook-summary.js";
import { defaultStatePath, acquireStateAndIdentity, releaseStateLock } from "./runner-state.js";
import { normalizeLoopbackHost } from "../relay-url.js";
import { startUsageRefreshLoop, stopUsageRefreshLoop } from "./runner-usage-cache.js";
import { startOllamaModelsRefreshLoop, stopOllamaModelsRefreshLoop } from "./runner-ollama-models-cache.js";
import { getWorkspaceRoots } from "./workspace.js";
import { type RunnerSession, spawnSession, killSessionProcessGroup } from "./session-spawner.js";
import { pruneSessionCloseMetadata, type SessionCloseMetadata } from "./session-close-metadata.js";

import { scanGlobalSkills } from "../skills.js";
import { scanGlobalAgents, readAgentContent } from "../agents.js";
import { scanAllPluginInfo } from "../plugins.js";
import { initUsage, triggerScan, closeUsage } from "../usage/index.js";

import { registerSkillsHandlers } from "./daemon-handlers/skills.js";
import { registerAgentsHandlers } from "./daemon-handlers/agents.js";
import { registerPluginsHandlers } from "./daemon-handlers/plugins.js";
import { registerSandboxHandlers } from "./daemon-handlers/sandbox.js";
import { registerModelsHandlers } from "./daemon-handlers/models.js";
import { registerUsageHandlers } from "./daemon-handlers/usage.js";
import { registerSessionAnalysisHandlers } from "./daemon-handlers/session-analysis.js";
import { registerSettingsHandlers } from "./daemon-handlers/settings.js";
import { registerPackagesHandlers } from "./daemon-handlers/packages.js";

// Re-export migration from shared module — used on daemon startup
import { migrateAgentDir } from "../migrations.js";
import { buildConfiguredGrantIdentities, reconcileGrants } from "../overlay/grants.js";

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

/** Panel/trigger/sigil metadata tracked per active service, keyed by service id. */
export type PanelEntry = {
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
     */
    hasPanel?: boolean;
    /**
     * Variable names the panel requires. The UI resolves these and appends
     * them as query params to the iframe src.
     */
    requires?: string[];
};

export interface TimeoutRaceResult<T> {
    value: T;
    timedOut: boolean;
}

/**
 * Race `promise` against `timeoutMs`. On timeout, resolves immediately with
 * `fallback()` and `timedOut: true` so a stalled discovery pass (e.g. a
 * hung dynamic `import()`) can never strand the rest of startup/reconfigure.
 * The original promise keeps running in the background; if/when it settles
 * after the timeout already fired, `onLate` is called with its value so the
 * caller can dispose it instead of silently mutating shared state (registry,
 * panel entries, etc.) out from under an already-completed pass.
 *
 * Pure/host-independent — exported for direct regression coverage with a
 * never-resolving promise, without real services or timers.
 */
export function raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    fallback: () => T,
    onLate?: (value: T) => void,
): Promise<TimeoutRaceResult<T>> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ value: fallback(), timedOut: true });
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                if (settled) {
                    onLate?.(value);
                    return;
                }
                settled = true;
                resolve({ value, timedOut: false });
            },
            () => {
                clearTimeout(timer);
                if (!settled) {
                    settled = true;
                    resolve({ value: fallback(), timedOut: true });
                }
            },
        );
    });
}

/**
 * Bound on a single discoverPackageServices() pass (dynamic `import()` of a
 * package's service entry can hang indefinitely on a bad/malicious module).
 * Shorter than PLUGIN_DISCOVERY_TIMEOUT_MS (the outer runner_registered
 * race) so a package timeout still leaves headroom for legacy discovery to
 * run and for registration to proceed on schedule.
 */
export const PACKAGE_DISCOVERY_TIMEOUT_MS = 20_000;

/** Fallback result used when a discoverPackageServices() pass times out — deliberately non-authoritative (see DiscoverPackageServicesResult). */
export function timedOutPackageDiscoveryResult(agentDir: string): DiscoverPackageServicesResult {
    return {
        services: [],
        errors: [{ path: agentDir, error: `package service discovery timed out after ${PACKAGE_DISCOVERY_TIMEOUT_MS}ms — treating as unknown, not "no packages"` }],
        authoritative: false,
    };
}

/** Best-effort disposal of a late (post-timeout) discoverPackageServices() result — never initialized, so dispose() is cleanup-only. */
function disposeLatePackageDiscovery(result: DiscoverPackageServicesResult): void {
    if (result.services.length === 0) return;
    logWarn(`[services] package service discovery finished after its timeout — discarding ${result.services.length} late result(s): ${result.services.map((s) => s.handler.id).join(", ")}`);
    for (const { handler } of result.services) {
        try {
            handler.dispose();
        } catch {
            // Never initialized — best-effort cleanup only.
        }
    }
}

export interface PackageServiceReconcilePlan {
    /** Ids that were package-mounted before but are no longer declared/granted this pass — dispose+unregister, drop all tracking. */
    revoke: string[];
    /** Ids whose winning identity is unchanged and still registered — preserve the running handler, only refresh panel/trigger/sigil metadata. */
    preserveRefreshMetadata: string[];
    /** Ids whose winning package identity changed since the last pass — dispose the old handler, then register the fresh one. */
    replaceIdentitySwap: string[];
    /** Ids currently held by a legacy-origin handler that package discovery now claims — dispose the legacy incumbent, then register the package handler. */
    evictLegacyThenRegister: string[];
    /** Ids with no incumbent at all — just register + init. */
    registerNew: string[];
}

/**
 * Decide what to do with each freshly-discovered package service against
 * the currently mounted state, without touching the registry/sockets/panel
 * map itself — the daemon executes the plan against real state; this
 * function is the actual decision logic reconfigure_services runs, exported
 * so package-before-legacy precedence and every reconfigure lifecycle edge
 * case (revocation/identity-swap/legacy-eviction/unchanged-preserve) has
 * direct regression coverage without spinning up sockets.
 */
export function planPackageServiceReconcile(
    freshPackageServices: ReadonlyArray<{ id: string; identity: string }>,
    packageServiceIds: ReadonlyMap<string, { identity: string }>,
    legacyServiceIds: ReadonlySet<string>,
    isRegistered: (id: string) => boolean,
): PackageServiceReconcilePlan {
    const freshIds = new Set(freshPackageServices.map((s) => s.id));
    const revoke = [...packageServiceIds.keys()].filter((id) => !freshIds.has(id));

    const preserveRefreshMetadata: string[] = [];
    const replaceIdentitySwap: string[] = [];
    const evictLegacyThenRegister: string[] = [];
    const registerNew: string[] = [];

    for (const { id, identity } of freshPackageServices) {
        const existing = packageServiceIds.get(id);
        if (existing && existing.identity === identity && isRegistered(id)) {
            preserveRefreshMetadata.push(id);
        } else if (existing) {
            replaceIdentitySwap.push(id);
        } else if (legacyServiceIds.has(id) && isRegistered(id)) {
            evictLegacyThenRegister.push(id);
        } else {
            registerNew.push(id);
        }
    }

    return { revoke, preserveRefreshMetadata, replaceIdentitySwap, evictLegacyThenRegister, registerNew };
}

export type DiscoveredServiceRejectReason = "builtin" | "collision";

/**
 * The has()-before-register collision guard registerDiscoveredService() runs
 * before mounting any discovered (non-built-in) service. Built-ins always
 * win; otherwise the FIRST caller to reach this check for a given id wins —
 * which is what makes package-before-legacy precedence (§8) fall out of
 * simply awaiting/registering the package discovery pass before the legacy
 * pass, rather than depending on ServiceRegistry.register() throwing.
 *
 * Pure/host-independent — exported for direct regression coverage of
 * registration-order precedence with a real ServiceRegistry, without
 * spinning up sockets.
 */
export function canRegisterDiscoveredService(
    isBuiltinReserved: boolean,
    isAlreadyRegistered: boolean,
): { register: true } | { register: false; reason: DiscoveredServiceRejectReason } {
    if (isBuiltinReserved) return { register: false, reason: "builtin" };
    if (isAlreadyRegistered) return { register: false, reason: "collision" };
    return { register: true };
}

/**
 * Derive the panelEntries value for a service from its manifest, preserving
 * an already-announced port across re-registration/metadata refresh.
 * Returns null when the manifest declares no panel/triggers/sigils (nothing
 * worth tracking). `hasPanel` prefers the manifest's explicit value (set by
 * package discovery) and falls back to inferring from `panel` presence for
 * legacy folder-based manifests that never set it explicitly — this is what
 * routes a trigger/sigil-only service to `announceSigilServer` instead of
 * `announcePanel` at init time.
 *
 * Pure and host-independent — exported for direct regression coverage
 * without spinning up the daemon/socket.
 */
export function panelEntryFromManifest(
    serviceId: string,
    manifest: ServiceManifest | undefined,
    existingPort?: number,
): PanelEntry | null {
    if (!manifest) return null;
    const hasTriggers = !!(manifest.triggers && manifest.triggers.length > 0);
    const hasSigils = !!(manifest.sigils && manifest.sigils.length > 0);
    if (!manifest.panel && !hasTriggers && !hasSigils) return null;
    return {
        serviceId,
        label: manifest.label,
        icon: manifest.icon,
        hasPanel: manifest.hasPanel ?? !!manifest.panel,
        ...(existingPort !== undefined ? { port: existingPort } : {}),
        ...(hasTriggers ? { triggers: manifest.triggers } : {}),
        ...(hasSigils ? { sigils: manifest.sigils } : {}),
        ...(manifest.panel?.requires ? { requires: manifest.panel.requires } : {}),
    };
}

/**
 * Remove ports owned by a stopped handler; optionally retain its disabled-state metadata.
 *
 * `releasePort` hands each port back to the tunnel (TunnelService.unregisterPort).
 * Dropping the port from these maps only stops it being *announced*; without the
 * release the runner keeps proxying traffic to a port the dead service no longer
 * owns. Optional so the pure map-hygiene behaviour stays unit-testable.
 */
export function clearServiceRuntimePorts(
    serviceId: string,
    panelEntries: Map<string, PanelEntry>,
    sigilServerPorts: Map<string, number>,
    keepMetadata: boolean,
    releasePort?: (port: number) => void,
): void {
    const sigilPort = sigilServerPorts.get(serviceId);
    if (sigilPort !== undefined) releasePort?.(sigilPort);
    sigilServerPorts.delete(serviceId);
    const entry = panelEntries.get(serviceId);
    if (!entry) return;
    if (entry.port !== undefined) releasePort?.(entry.port);
    if (!keepMetadata) {
        panelEntries.delete(serviceId);
        return;
    }
    const { port: _stalePort, ...metadata } = entry;
    panelEntries.set(serviceId, metadata);
}

/**
 * Retire legacy (plugin-dir) services that vanished between rediscovery passes.
 *
 * A deleted plugin used to have only its *metadata* forgotten, which left the
 * handler registered, initialized and still serving on its announced port.
 * Exported so the reconfigure lifecycle is covered by a live-registry test
 * rather than a mirrored re-implementation of this loop.
 *
 * @returns the ids that were retired.
 */
export function removeVanishedLegacyServices(opts: {
    tracked: Set<string>;
    legacyServiceIds: Set<string>;
    packageServiceIds: ReadonlySet<string>;
    disabledIds: ReadonlySet<string>;
    stillDiscovered: ReadonlySet<string>;
    panelEntries: Map<string, PanelEntry>;
    sigilServerPorts: Map<string, number>;
    disposeIncumbent: (id: string, reason: string) => void;
    releasePort?: (port: number) => void;
}): string[] {
    const removed: string[] = [];
    for (const id of [...opts.tracked]) {
        if (opts.packageServiceIds.has(id)) continue; // Package-origin ids reconcile separately
        if (opts.disabledIds.has(id)) continue;       // Keep disabled services
        if (opts.stillDiscovered.has(id)) continue;   // Still on disk
        opts.disposeIncumbent(id, `legacy service "${id}" is no longer discoverable (plugin deleted) — disposing handler`);
        opts.tracked.delete(id);
        opts.legacyServiceIds.delete(id);
        clearServiceRuntimePorts(id, opts.panelEntries, opts.sigilServerPorts, false, opts.releasePort);
        removed.push(id);
    }
    return removed;
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
            handler.init(socket as unknown as PizzaPiSocket, makeOpts(handler));
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
 * Grace window for a worker's graceful shutdown before SIGKILL, on every
 * escalation path (process-group signal, single-child SIGTERM/message
 * fallback). Must cover the worker's own shutdown budget: provider close
 * (<=2.5s, one overall deadline — see runProviderSessionClose) + sandbox
 * cleanup (<=5s) = 7.5s worst case.
 */
const SESSION_SHUTDOWN_GRACE_MS = 8_000;

/**
 * Escalate a SIGTERM to SIGKILL after `timeoutMs` if the child has not exited.
 * The timer is cleared automatically when the child exits.
 * ponytail: child-process escalation is hard to unit-test without real spawned
 * processes; covered by the real SIGTERM/SIGKILL behavior in session-spawner.
 */
function escalateToSigkill(child: ChildProcess, label: string, timeoutMs = SESSION_SHUTDOWN_GRACE_MS): void {
    const timer = setTimeout(() => {
        try {
            if (!child.killed && child.exitCode === null) {
                logWarn(`[daemon] ${label} did not exit after ${timeoutMs}ms; force-killing`);
                // Kill the whole process group (worker + descendants); fall back
                // to tree-kill (Windows) / plain kill if group signaling isn't possible.
                if (!killSessionProcessGroup(child.pid, "SIGKILL")) forceKillTree(child);
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
export function resolveConfiguredAgentDir(cwd = process.cwd()): string {
    const config = loadConfig(cwd);
    return config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
}

/**
 * Reconcile overlayServiceGrants against currently configured USER packages
 * and their currently declared manifest service IDs (§7.2). Call at daemon
 * startup and on `reconfigure_services` — this only edits
 * ~/.pizzapi/config.json, it never mounts/unmounts services (that's driven
 * separately by discoverServices()). Exported standalone (rather than an
 * inline closure) so the startup/reconfigure call path has direct
 * regression coverage without spinning up the full socket.io daemon.
 */
export function reconcileOverlayGrants(cwd = process.cwd()): void {
    try {
        const agentDir = resolveConfiguredAgentDir(cwd);
        const configured = buildConfiguredGrantIdentities(cwd, agentDir);
        const removals = reconcileGrants(configured);
        for (const removal of removals) {
            logInfo(
                `[grants] reconciliation removed [${removal.removedServiceIds.join(", ")}] for ${removal.package}` +
                    `${removal.fullyRemoved ? " (grant cleared)" : " (grant trimmed)"}`,
            );
        }
    } catch (err) {
        logWarn(`[grants] reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Model discovery for the daemon's `list_models` socket event and context-window
 * lookups. Builds a bare ModelRuntime (no extension loading), so ollama-cloud
 * needs an explicit registerOllamaCloudProvider() call to be recognized at all —
 * see ollama-cloud-models.ts. Exported standalone (rather than an inline closure)
 * so this real discovery path has direct regression coverage.
 */
export async function listConfiguredModels(cwd = process.cwd()): Promise<SessionModelEntry[]> {
    const agentDir = resolveConfiguredAgentDir(cwd);
    const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
    });
    // This runtime never loads extensions, so "ollama-cloud" is otherwise an
    // unknown provider here: no offline fallback catalog and stored/env
    // credentials go unrecognized. Mirrors ollamaCloudProviderExtension.
    registerOllamaCloudProvider(runtime);
    const modelRegistry = new ModelRegistry(runtime);
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
    if (runtime.hasConfiguredAuth("ollama-cloud") || process.env.OLLAMA_API_KEY) {
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
}

export async function runDaemon(_args: string[] = []): Promise<number> {
    setLogComponent("daemon");
    const statePath = defaultStatePath();
    const identity = acquireStateAndIdentity(statePath);

    // Migrate session storage from legacy locations into flat ~/.pizzapi/
    migrateAgentDir();

    // Reconcile overlayServiceGrants against currently configured USER
    // packages before anything else touches trust state (§7.2). No service
    // mounting happens here — grants-only bookkeeping.
    reconcileOverlayGrants();

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

    // Package-origin service discovery is runner-global (grants are user-scope
    // only, §7.2) — resolve once, reused by startup discovery and every
    // reconfigure_services pass.
    const packageDiscoveryCwd = process.cwd();
    const packageDiscoveryAgentDir = resolveConfiguredAgentDir(packageDiscoveryCwd);

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
        if (isServiceDisabled("process")) {
            logInfo('[services] built-in service "process" disabled by config');
        } else {
            registry.register(new ProcessService((sessionId) => runningSessions.get(sessionId)?.child?.pid ?? null));
        }
        const cleanupSessionServices = (sessionId: string) => {
            for (const handler of registry.getAll()) {
                handler.handleSessionEnded?.(sessionId);
            }
        };
        const sessionCloseMetadata = new Map<string, SessionCloseMetadata>();
        const setSessionCloseMetadata = (sessionId: string, metadata: Omit<SessionCloseMetadata, "updatedAt">) => {
            sessionCloseMetadata.set(sessionId, { ...metadata, updatedAt: Date.now() });
            pruneSessionCloseMetadata(sessionCloseMetadata, runningSessions);
        };
        const sessionCloseMetadataSweep = setInterval(() => {
            pruneSessionCloseMetadata(sessionCloseMetadata, runningSessions);
        }, 5 * 60_000);
        if (isServiceDisabled("memory")) {
            logInfo('[services] built-in service "memory" disabled by config');
        } else {
            registry.register(new MemoryService((sessionId) => sessionCloseMetadata.get(sessionId)?.cwd ?? null));
        }
        const getContextWindowsForAnalysis = async (cwd = process.cwd()): Promise<Map<string, number>> => {
            const windows = new Map<string, number>();
            try {
                for (const model of await listConfiguredModels(cwd)) {
                    if (typeof model.contextWindow !== "number") continue;
                    windows.set(`${model.provider}:${model.id}`, model.contextWindow);
                }
            } catch (err) {
                logWarn(`[daemon] Failed to load model context windows for analysis: ${err instanceof Error ? err.message : String(err)}`);
            }
            return windows;
        };
        // NOTE: provider onSessionClose runs IN THE WORKER PROCESS during its
        // SIGTERM/shutdownHandler paths (see extensions/providers/extension.ts
        // runProviderSessionClose). The daemon previously imported
        // triggerSessionClose here, but that was a guaranteed no-op: the
        // provider bridge is a module-global initialized only in the worker.
        // Daemon-side crash finalization (worker died without running close)
        // is tracked as the Phase 3 finalizer contract (idea jg017xa4).
        const tunnelService = new TunnelService();
        if (isServiceDisabled("tunnel")) {
            logInfo('[services] built-in service "tunnel" disabled by config');
        } else {
            registry.register(tunnelService);
        }

        /** Hand a dead service's pinned port back to the tunnel (see clearServiceRuntimePorts). */
        const releaseServicePort = (port: number): void => {
            tunnelService.unregisterPort(port);
        };

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
        const panelEntries = new Map<string, PanelEntry>();
        // Track ALL discovered service IDs (including disabled ones) so the UI can show them.
        const allDiscoveredServiceIds = new Set<string>();
        // Package-origin service ids currently mounted, keyed by their normalized
        // package identity (§7.2/§9.2 provenance). Reconfiguration diffs this
        // against a fresh discoverPackageServices() pass to dispose/unregister
        // services whose grant/package/declaration was revoked or removed.
        const packageServiceIds = new Map<string, { identity: string }>();
        // Legacy-origin (global-dir/project-dir/plugin-manifest) service ids
        // currently mounted — lets reconfigure distinguish "this id is already
        // active from an earlier pass of the SAME origin, leave it running" from
        // "this id now collides with a different origin," without relying on
        // ServiceRegistry.register() throwing.
        const legacyServiceIds = new Set<string>();

        /**
         * Register a discovered (non-built-in) service if its id isn't reserved
         * by a built-in or already claimed by an earlier registration this pass.
         * Shared by the package/legacy startup and reconfigure loops so the
         * has()-before-register collision rule (§8) — built-ins always win, never
         * rely on ServiceRegistry.register() throwing for duplicates — lives in
         * exactly one place, and package-before-legacy precedence falls out of
         * simply awaiting the package loop before the legacy loop.
         */
        const registerDiscoveredService = (
            handler: ServiceHandler,
            source: ServicePluginResult["source"],
            manifest: ServiceManifest | undefined,
            kind: "package" | "legacy",
        ): boolean => {
            const from = source.pluginName ?? source.path;
            const decision = canRegisterDiscoveredService(BUILTIN_SERVICE_IDS.has(handler.id), registry.has(handler.id));
            if (!decision.register) {
                const why = decision.reason === "builtin" ? "collides with a reserved built-in service id" : "collides with an already-registered service";
                logWarn(`[services] ${kind} service "${handler.id}" from ${from} ${why} — skipped`);
                return false;
            }
            registry.register(handler);
            allDiscoveredServiceIds.add(handler.id);
            logInfo(`[services] loaded ${kind} service "${handler.id}" from ${from}`);
            const entry = panelEntryFromManifest(handler.id, manifest, panelEntries.get(handler.id)?.port);
            if (entry) panelEntries.set(handler.id, entry);
            if (kind === "package") packageServiceIds.set(handler.id, { identity: source.pluginName ?? handler.id });
            else legacyServiceIds.add(handler.id);
            return true;
        };

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

        // Discover and register package-origin and legacy plugin-provided
        // services. pluginServicesReady resolves once both passes are complete.
        // The runner_registered handler awaits this before announcing services.
        //
        // Package discovery (§6/§7/§9.2) is AWAITED and registered before legacy
        // discovery (§8) — this is what makes package-over-legacy precedence
        // deterministic rather than dependent on async completion order.
        let resolvePluginServices: () => void;
        const pluginServicesReady = new Promise<void>(r => { resolvePluginServices = r; });
        (async () => {
            try {
                // Bounded so a stalled package import can never strand legacy
                // discovery below (§C) — late results are discarded, not mutated in.
                const { value: { services, errors }, timedOut } = await raceWithTimeout(
                    discoverPackageServices({
                        cwd: packageDiscoveryCwd,
                        agentDir: packageDiscoveryAgentDir,
                        disabledIds: disabledServices,
                    }),
                    PACKAGE_DISCOVERY_TIMEOUT_MS,
                    () => timedOutPackageDiscoveryResult(packageDiscoveryAgentDir),
                    disposeLatePackageDiscovery,
                );
                if (timedOut) logWarn(`[services] package service discovery did not complete within ${PACKAGE_DISCOVERY_TIMEOUT_MS}ms; proceeding without package services this pass`);
                for (const { handler, source, manifest } of services) {
                    registerDiscoveredService(handler, source, manifest, "package");
                }
                for (const { path, error } of errors) {
                    logWarn(`[services] package service discovery: ${error} (${path})`);
                }
            } catch (err) {
                logWarn(`[services] package service discovery failed: ${err}`);
            }

            try {
                const { services, errors } = await discoverServices({ pluginDirs: globalPluginDirs(), disabledIds: disabledServices });
                for (const { handler, source, manifest } of services) {
                    registerDiscoveredService(handler, source, manifest, "legacy");
                }
                for (const { path, error } of errors) {
                    logWarn(`[services] plugin service load error at ${path}: ${error}`);
                }
            } catch (err) {
                logWarn(`[services] plugin service discovery failed: ${err}`);
            }

            resolvePluginServices!();
        })();

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

                // Reconcile overlayServiceGrants against currently configured
                // USER packages (§7.2) — grants-only bookkeeping, no service
                // (un)mounting here.
                reconcileOverlayGrants();

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

                // Disable any non-permanently-pinned service (package-,
                // legacy-, or the memory/process built-ins) that is now in
                // the disabled set. NON_DISABLEABLE_SERVICE_IDS (not the
                // broader BUILTIN_SERVICE_IDS collision-reservation set) is
                // the runtime-disable gate — memory/process must stay
                // disableable at runtime like every other built-in used to be.
                const servicesToDisable = registry.getAll()
                    .filter(s => !NON_DISABLEABLE_SERVICE_IDS.has(s.id) && newDisabledServices.has(s.id));
                for (const svc of servicesToDisable) {
                    logInfo(`[services] disabling service "${svc.id}"`);
                    try {
                        svc.dispose();
                    } catch (err) {
                        logWarn(`[services] dispose failed for "${svc.id}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
                    }
                    registry.unregister(svc.id);
                    initializedServiceIds.delete(svc.id);
                    packageServiceIds.delete(svc.id);
                    legacyServiceIds.delete(svc.id);
                    // Keep disabled-service metadata visible, but never re-announce its dead ports.
                    clearServiceRuntimePorts(svc.id, panelEntries, sigilServerPorts, true, releaseServicePort);
                }

                /** Dispose + unregister a running handler so no timers/sockets outlive it. */
                const disposeIncumbent = (id: string, reason: string) => {
                    const oldSvc = registry.get(id);
                    if (!oldSvc) return;
                    logInfo(`[services] ${reason}`);
                    try {
                        oldSvc.dispose();
                    } catch (err) {
                        logWarn(`[services] dispose failed for "${id}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
                    }
                    registry.unregister(id);
                    initializedServiceIds.delete(id);
                };

                const initAndTrack = (handler: ServiceHandler, kind: "package" | "legacy") => {
                    try {
                        handler.init(socket as unknown as PizzaPiSocket, optsForInit(handler.id));
                        initializedServiceIds.add(handler.id);
                        if (typeof handler.reconcileSubscriptions === "function") {
                            const subs = cachedTriggerSubscriptions.filter((sub) => sub.triggerType?.split(":")[0] === handler.id);
                            const result = handler.reconcileSubscriptions(subs, { mode: "snapshot" });
                            logInfo(`[trigger-reconciliation] service "${handler.id}" hot-reload applied ${result.applied}/${subs.length} cached subscriptions${result.errors?.length ? `, errors=${result.errors.length}` : ""}`);
                        }
                    } catch (err) {
                        logWarn(`[services] failed to init ${kind} service "${handler.id}": ${err}`);
                    }
                };

                // ── Package-origin services: awaited + registered before legacy (§8) ──
                // Bounded so a stalled package import can never hang reconfigure
                // indefinitely (§C); a timeout also forces authoritative=false below.
                const {
                    value: { services: freshPackageServices, errors: packageErrors, authoritative: packageDiscoveryAuthoritative },
                    timedOut: packageDiscoveryTimedOut,
                } = await raceWithTimeout(
                    discoverPackageServices({
                        cwd: packageDiscoveryCwd,
                        agentDir: packageDiscoveryAgentDir,
                        disabledIds: newDisabledServices,
                    }),
                    PACKAGE_DISCOVERY_TIMEOUT_MS,
                    () => timedOutPackageDiscoveryResult(packageDiscoveryAgentDir),
                    disposeLatePackageDiscovery,
                );
                if (packageDiscoveryTimedOut) {
                    logWarn(`[services] package service discovery did not complete within ${PACKAGE_DISCOVERY_TIMEOUT_MS}ms during reconfigure`);
                }

                if (!packageDiscoveryAuthoritative) {
                    // Corrupt/unreadable GLOBAL settings, or a discovery timeout: the
                    // fresh result is not a trustworthy "no packages" answer. Never
                    // treat it as authorization to dispose currently running package
                    // services — skip the reconcile/register diff entirely and just
                    // surface whatever per-package errors did come through.
                    logWarn(`[services] package service discovery is not authoritative this pass — preserving ${packageServiceIds.size} currently active package service(s) untouched`);
                    for (const { path, error } of packageErrors) {
                        logWarn(`[services] package service discovery: ${error} (${path})`);
                    }
                } else {
                    const freshById = new Map(freshPackageServices.map((s) => [s.handler.id, s] as const));
                    const plan = planPackageServiceReconcile(
                        freshPackageServices.map((s) => ({ id: s.handler.id, identity: s.source.pluginName ?? s.handler.id })),
                        packageServiceIds,
                        legacyServiceIds,
                        (id) => registry.has(id),
                    );

                    // Ids that were package-mounted before but are no longer
                    // declared/granted this pass (distinct from the disable-set
                    // handling above).
                    for (const id of plan.revoke) {
                        const svc = registry.get(id);
                        if (svc) {
                            logInfo(`[services] unregistering package service "${id}" (revoked or no longer declared)`);
                            try {
                                svc.dispose();
                            } catch (err) {
                                logWarn(`[services] dispose failed for "${id}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
                            }
                            registry.unregister(id);
                            initializedServiceIds.delete(id);
                        }
                        packageServiceIds.delete(id);
                        allDiscoveredServiceIds.delete(id);
                        clearServiceRuntimePorts(id, panelEntries, sigilServerPorts, false, releaseServicePort);
                    }

                    // Unchanged winning identity — preserve the running lifecycle,
                    // but refresh panel/trigger/sigil metadata from the fresh
                    // manifest (the package could have been reinstalled/updated
                    // without its identity changing).
                    for (const id of plan.preserveRefreshMetadata) {
                        const manifest = freshById.get(id)?.manifest;
                        const entry = panelEntryFromManifest(id, manifest, panelEntries.get(id)?.port);
                        if (entry) panelEntries.set(id, entry);
                        else panelEntries.delete(id);
                    }

                    // Same service id, but the package identity that won it changed
                    // underneath it — dispose the incumbent before mounting the new
                    // one so stale handler state/timers never linger alongside it.
                    for (const id of plan.replaceIdentitySwap) {
                        const existing = packageServiceIds.get(id);
                        const freshIdentity = freshById.get(id)?.source.pluginName ?? id;
                        disposeIncumbent(id, `package service "${id}" identity changed (${existing?.identity} → ${freshIdentity}) — disposing old handler`);
                        packageServiceIds.delete(id);
                        clearServiceRuntimePorts(id, panelEntries, sigilServerPorts, false, releaseServicePort);
                    }

                    // A legacy-origin service currently holds this id from an
                    // earlier pass, but package discovery now declares it — evict
                    // the legacy incumbent so package-over-legacy precedence (§8)
                    // holds dynamically, without requiring a daemon restart.
                    for (const id of plan.evictLegacyThenRegister) {
                        disposeIncumbent(id, `package service "${id}" supersedes legacy incumbent — disposing legacy handler`);
                        legacyServiceIds.delete(id);
                        allDiscoveredServiceIds.delete(id);
                        clearServiceRuntimePorts(id, panelEntries, sigilServerPorts, false, releaseServicePort);
                    }

                    for (const id of [...plan.replaceIdentitySwap, ...plan.evictLegacyThenRegister, ...plan.registerNew]) {
                        const fresh = freshById.get(id);
                        if (!fresh) continue;
                        if (!registerDiscoveredService(fresh.handler, fresh.source, fresh.manifest, "package")) continue;
                        initAndTrack(fresh.handler, "package");
                    }
                    for (const { path, error } of packageErrors) {
                        logWarn(`[services] package service discovery: ${error} (${path})`);
                    }
                }

                // ── Legacy plugin-provided services ────────────────────────────────
                const { services: discoveredServices, errors } = await discoverServices(
                    { pluginDirs: globalPluginDirs(), disabledIds: newDisabledServices },
                );

                // Remove legacy services that are no longer discoverable (plugin
                // deleted) and not disabled. Package-origin ids are reconciled above.
                removeVanishedLegacyServices({
                    tracked: allDiscoveredServiceIds,
                    legacyServiceIds,
                    packageServiceIds: new Set(packageServiceIds.keys()),
                    disabledIds: newDisabledServices,
                    stillDiscovered: new Set(discoveredServices.map(s => s.handler.id)),
                    panelEntries,
                    sigilServerPorts,
                    disposeIncumbent,
                    releasePort: releaseServicePort,
                });

                for (const { handler, source, manifest } of discoveredServices) {
                    if (legacyServiceIds.has(handler.id) && registry.has(handler.id)) continue; // unchanged — preserve lifecycle
                    if (!registerDiscoveredService(handler, source, manifest, "legacy")) continue;
                    initAndTrack(handler, "legacy");
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
                        // Signal the whole process group so background processes
                        // spawned by the session die too. Falls back to the
                        // standard graceful path (IPC shutdown message on Windows,
                        // where kill() would TerminateProcess and skip cleanup;
                        // plain SIGTERM elsewhere) if group signaling fails.
                        const child = entry.child;
                        if (!killSessionProcessGroup(child.pid)) {
                            // Same grace window as the process-group path below —
                            // the default 5s in process-kill.ts's signature is too
                            // short for provider close + sandbox cleanup.
                            requestChildShutdown(
                                child,
                                (timeoutMs) =>
                                    logWarn(`[daemon] session ${sessionId} did not exit after ${timeoutMs}ms; force-killing`),
                                SESSION_SHUTDOWN_GRACE_MS,
                            );
                        } else {
                            escalateToSigkill(child, `session ${sessionId}`, SESSION_SHUTDOWN_GRACE_MS);
                        }
                    } catch {}
                } else if (entry.adopted) {
                    // No child handle — ask the relay to disconnect the worker's
                    // socket, which sends end_session then force-disconnects.
                    socket.emit("disconnect_session", { sessionId });
                }
                runningSessions.delete(sessionId);
                endedSessionIds.set(sessionId, Date.now());
                cleanupSessionServices(sessionId);
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
            let sessionFullyEnded = false;
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
                sessionFullyEnded = true;
                logInfo(`session ${sessionId} ended on relay${entry.adopted ? " (adopted)" : ""}${reason ? ` (${reason})` : ""}`);
            } else if (!endedSessionIds.has(sessionId)) {
                // First duplicate — log once then suppress subsequent copies
                endedSessionIds.set(sessionId, Date.now());
                sessionFullyEnded = true;
                logInfo(`session_ended for unknown/already-removed session ${sessionId}`);
            }
            // else: duplicate session_ended for a session we already handled — silently ignore

            cleanupSessionServices(sessionId);
            if (sessionFullyEnded) sessionCloseMetadata.delete(sessionId);

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

        // ── Skills / agents / plugins / sandbox / models / usage handlers ──
        registerSkillsHandlers(socket, () => isShuttingDown);
        registerAgentsHandlers(socket, () => isShuttingDown);
        registerPluginsHandlers(socket, () => isShuttingDown);
        registerSandboxHandlers(socket, () => isShuttingDown);
        registerModelsHandlers(socket, () => isShuttingDown, listConfiguredModels);
        registerUsageHandlers(socket, () => isShuttingDown);

        // ── Session analysis / settings / packages handlers ────────────────
        registerSessionAnalysisHandlers(
            socket,
            () => isShuttingDown,
            runningSessions,
            sessionCloseMetadata,
            resolveConfiguredAgentDir,
            getContextWindowsForAnalysis,
        );
        registerSettingsHandlers(socket, () => isShuttingDown);
        registerPackagesHandlers(socket, () => isShuttingDown);

        // ── Error handling ────────────────────────────────────────────────

        socket.on("error", (data: any) => {
            logError(`server error: ${data.message}`);
        });
    });
}
