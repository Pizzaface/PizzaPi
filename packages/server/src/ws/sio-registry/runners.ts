// ============================================================================
// runners.ts — Runner registration and management
//
// Covers:
//   - Runner registration with persistent identity (runnerId + secret)
//   - Runner metadata updates (skills, agents, plugins, hooks)
//   - Session↔runner association lifecycle
//   - Runner listing and lookup helpers
// ============================================================================

import type { Socket } from "socket.io";
import { randomUUID } from "crypto";
import {
    type RedisRunnerData,
    setRunner,
    getRunner as getRunnerState,
    updateRunnerFields,
    deleteRunner as deleteRunnerState,
    getAllRunners,
    refreshRunnerTTL,
    getSession,
    updateSessionFields,
    getAllSessionSummaries,
    setPendingRunnerLink,
    setRunnerAssociation,
    deleteRunnerAssociation,
} from "../sio-state/index.js";
import { updateRelaySessionRunner } from "../../sessions/store.js";
import type { RunnerInfo, RunnerSkill, RunnerAgent, RunnerHook, ServiceTriggerDef, ServiceSigilDef } from "@pizzapi/protocol";
import {
    localTuiSockets,
    localRunnerSockets,
    runnerSecrets,
    runnerRoom,
    safeJsonParse,
    modelFromHeartbeat,
    getIo,
} from "./context.js";
import { broadcastToHub } from "./hub.js";
import { broadcastToRunnersNs } from "./runners-broadcast.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio-registry");

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeRoot(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const normalized = trimmed.replace(/\\/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function normalizeSkills(raw: unknown): RunnerSkill[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
        .map((s) => ({
            name: typeof s.name === "string" ? s.name : "",
            description: typeof s.description === "string" ? s.description : "",
            filePath: typeof s.filePath === "string" ? s.filePath : "",
        }))
        .filter((s) => s.name.length > 0);
}

function normalizeAgents(raw: unknown): RunnerAgent[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((a): a is Record<string, unknown> => a !== null && typeof a === "object")
        .map((a) => ({
            name: typeof a.name === "string" ? a.name : "",
            description: typeof a.description === "string" ? a.description : "",
            filePath: typeof a.filePath === "string" ? a.filePath : "",
        }))
        .filter((a) => a.name.length > 0);
}

/**
 * Normalize a plugin info object to guaranteed types.
 * Ensures all arrays are arrays, booleans are booleans, strings are strings.
 */
function normalizePlugin(raw: Record<string, unknown>): Record<string, unknown> | null {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return null;

    return {
        name,
        description: typeof raw.description === "string" ? raw.description : "",
        rootPath: typeof raw.rootPath === "string" ? raw.rootPath : "",
        commands: Array.isArray(raw.commands) ? raw.commands.filter((c: unknown) => c && typeof c === "object") : [],
        hookEvents: Array.isArray(raw.hookEvents) ? raw.hookEvents.filter((e: unknown) => typeof e === "string") : [],
        skills: Array.isArray(raw.skills) ? raw.skills.filter((s: unknown) => s && typeof s === "object") : [],
        agents: Array.isArray(raw.agents) ? raw.agents.filter((a: unknown) => a && typeof a === "object") : undefined,
        rules: Array.isArray(raw.rules)
            ? raw.rules.filter((r: unknown): r is { name: string } => r !== null && typeof r === "object" && typeof (r as Record<string, unknown>).name === "string")
            : undefined,
        hasMcp: raw.hasMcp === true,
        hasAgents: raw.hasAgents === true,
        hasLsp: raw.hasLsp === true,
        version: typeof raw.version === "string" ? raw.version : undefined,
        author: typeof raw.author === "string" ? raw.author : undefined,
    };
}

// ── Runner Management ───────────────────────────────────────────────────────

export interface RegisterRunnerOpts {
    name?: string | null;
    roots?: string[];
    requestedRunnerId?: string;
    runnerSecret?: string;
    skills?: RunnerSkill[];
    agents?: RunnerAgent[];
    plugins?: unknown[];
    hooks?: RunnerHook[];
    userId?: string | null;
    userName?: string | null;
    version?: string | null;
    platform?: string | null;
}

/**
 * Register a runner via Socket.IO.
 *
 * Handles persistent identity via runnerId + runnerSecret (same logic
 * as the existing registry.ts).
 *
 * Returns the runnerId on success, or an Error on auth failure.
 */
export async function registerRunner(
    socket: Socket,
    opts: RegisterRunnerOpts = {},
): Promise<string | Error> {
    const requestedId = opts.requestedRunnerId?.trim();
    const secret = opts.runnerSecret?.trim();

    let runnerId: string;

    if (requestedId && secret) {
        const existingSecret = runnerSecrets.get(requestedId);
        if (existingSecret !== undefined) {
            if (existingSecret !== secret) {
                return new Error(`Runner authentication failed: secret mismatch for runner ${requestedId}`);
            }
            // Re-registration: clean up stale socket
            localRunnerSockets.delete(requestedId);
        } else {
            runnerSecrets.set(requestedId, secret);
        }
        runnerId = requestedId;
    } else {
        runnerId = randomUUID();
    }

    const roots = (opts.roots ?? [])
        .filter((r) => typeof r === "string")
        .map(normalizeRoot)
        .filter(Boolean);

    const skills = normalizeSkills(opts.skills);
    const agents = normalizeAgents(opts.agents);
    const plugins = Array.isArray(opts.plugins)
        ? opts.plugins
            .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
            .map(normalizePlugin)
            .filter((p): p is Record<string, unknown> => p !== null)
        : [];

    const hooks = Array.isArray(opts.hooks)
        ? opts.hooks.filter(
              (h): h is RunnerHook =>
                  h !== null &&
                  typeof h === "object" &&
                  typeof (h as RunnerHook).type === "string" &&
                  Array.isArray((h as RunnerHook).scripts),
          )
        : [];

    const runnerData: RedisRunnerData = {
        runnerId,
        userId: opts.userId ?? null,
        userName: opts.userName ?? null,
        name: opts.name?.trim() || null,
        roots: JSON.stringify(roots),
        skills: JSON.stringify(skills),
        agents: JSON.stringify(agents),
        plugins: JSON.stringify(plugins),
        hooks: JSON.stringify(hooks),
        version: typeof opts.version === "string" ? opts.version : null,
        platform: typeof opts.platform === "string" ? opts.platform : null,
    };

    await setRunner(runnerId, runnerData);
    localRunnerSockets.set(runnerId, socket);

    // Join a per-runner room so cluster-wide emits can reach this runner via
    // the Redis adapter (see emitToRunner / endSharedSession).
    await socket.join(runnerRoom(runnerId));

    // Broadcast runner_added to connected browsers
    void broadcastToRunnersNs("runner_added", runnerDataToInfo(runnerData), opts.userId ?? undefined);

    return runnerId;
}

/** Update skills for an already-registered runner. */
export async function updateRunnerSkills(runnerId: string, skills: RunnerSkill[]): Promise<void> {
    const normalized = normalizeSkills(skills);
    await updateRunnerFields(runnerId, { skills: JSON.stringify(normalized) });
    const fresh = await getRunnerState(runnerId);
    if (fresh) {
        void broadcastToRunnersNs("runner_updated", runnerDataToInfo(fresh), fresh.userId ?? undefined);
    }
}

/** Update agents for an already-registered runner. */
export async function updateRunnerAgents(runnerId: string, agents: RunnerAgent[]): Promise<void> {
    const normalized = normalizeAgents(agents);
    await updateRunnerFields(runnerId, { agents: JSON.stringify(normalized) });
    const fresh = await getRunnerState(runnerId);
    if (fresh) {
        void broadcastToRunnersNs("runner_updated", runnerDataToInfo(fresh), fresh.userId ?? undefined);
    }
}

/**
 * Persist the runner's discovered Claude Code plugins to Redis.
 * Plugins are stored as a JSON-serialized array in the runner hash.
 * Each plugin is schema-normalized to guarantee expected field types.
 */
export async function updateRunnerPlugins(runnerId: string, plugins: unknown[]): Promise<void> {
    const normalized = Array.isArray(plugins)
        ? plugins
            .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
            .map(normalizePlugin)
            .filter((p): p is Record<string, unknown> => p !== null)
        : [];
    await updateRunnerFields(runnerId, { plugins: JSON.stringify(normalized) });
    const fresh = await getRunnerState(runnerId);
    if (fresh) {
        void broadcastToRunnersNs("runner_updated", runnerDataToInfo(fresh), fresh.userId ?? undefined);
    }
}

/** Add a warning to the runner's warnings list. Deduplicates by message. */
export async function addRunnerWarning(runnerId: string, message: string): Promise<void> {
    const existing = await getRunnerState(runnerId);
    if (!existing) return;
    const current: string[] = existing.warnings ? safeJsonParse(existing.warnings) ?? [] : [];
    if (current.includes(message)) return; // already present
    current.push(message);
    await updateRunnerFields(runnerId, { warnings: JSON.stringify(current) });
    const fresh = await getRunnerState(runnerId);
    if (fresh) {
        void broadcastToRunnersNs("runner_updated", runnerDataToInfo(fresh), fresh.userId ?? undefined);
    }
}

/** Clear all warnings for a runner. */
export async function clearRunnerWarnings(runnerId: string): Promise<void> {
    await updateRunnerFields(runnerId, { warnings: "[]" });
    const fresh = await getRunnerState(runnerId);
    if (fresh) {
        void broadcastToRunnersNs("runner_updated", runnerDataToInfo(fresh), fresh.userId ?? undefined);
    }
}

/**
 * Persist service announce data (service IDs, panels, trigger defs) to Redis.
 * Called when a runner emits service_announce so the data survives
 * server restarts and is available to late-joining viewers without
 * waiting for a fresh announce from the runner.
 */
export async function updateRunnerServices(
    runnerId: string,
    serviceIds: string[],
    panels?: Array<{ serviceId: string; port: number; label: string; icon: string }>,
    triggerDefs?: Array<{ type: string; label: string; description?: string; schema?: Record<string, unknown> }>,
    sigilDefs?: Array<{ type: string; label: string; description?: string; icon?: string; serviceId?: string; resolve?: string; schema?: Record<string, unknown>; aliases?: string[] }>,
): Promise<void> {
    const fields: Record<string, string> = {
        serviceIds: JSON.stringify(serviceIds),
    };
    if (panels && panels.length > 0) {
        fields.panels = JSON.stringify(panels);
    } else {
        fields.panels = "[]";
    }
    if (triggerDefs && triggerDefs.length > 0) {
        fields.triggerDefs = JSON.stringify(triggerDefs);
    } else {
        fields.triggerDefs = "[]";
    }
    if (sigilDefs && sigilDefs.length > 0) {
        fields.sigilDefs = JSON.stringify(sigilDefs);
    } else {
        fields.sigilDefs = "[]";
    }
    await updateRunnerFields(runnerId, fields);
    // No broadcast here — service_announce is already forwarded to viewers
    // in real-time via the socket event. This is just persistence.
}

/**
 * Read cached service announce data from Redis for a runner.
 * Returns null if no service data has been persisted yet.
 */
export async function getRunnerServices(
    runnerId: string,
): Promise<{
    serviceIds: string[];
    panels?: Array<{ serviceId: string; port: number; label: string; icon: string }>;
    triggerDefs?: ServiceTriggerDef[];
    sigilDefs?: ServiceSigilDef[];
} | null> {
    const runner = await getRunnerState(runnerId);
    if (!runner?.serviceIds) return null;
    const serviceIds: string[] = safeJsonParse(runner.serviceIds) ?? [];
    if (serviceIds.length === 0) return null;
    const panels = runner.panels ? safeJsonParse(runner.panels) ?? undefined : undefined;
    const triggerDefs = runner.triggerDefs ? safeJsonParse(runner.triggerDefs) ?? undefined : undefined;
    const sigilDefs = runner.sigilDefs ? safeJsonParse(runner.sigilDefs) ?? undefined : undefined;
    return {
        serviceIds,
        ...(panels && panels.length > 0 ? { panels } : {}),
        ...(triggerDefs && triggerDefs.length > 0 ? { triggerDefs } : {}),
        ...(sigilDefs && sigilDefs.length > 0 ? { sigilDefs } : {}),
    };
}

/** Record that a runner spawned a session. */
export async function recordRunnerSession(runnerId: string, sessionId: string): Promise<void> {
    // Runner-session associations tracked via session.runnerId in Redis
    const session = await getSession(sessionId);
    if (session) {
        await updateSessionFields(sessionId, { runnerId });
    }
}

/**
 * Associate a session with the runner that spawned it, then notify hub.
 */
export async function linkSessionToRunner(runnerId: string, sessionId: string): Promise<void> {
    const runner = await getRunnerState(runnerId);
    if (!runner) return;

    const session = await getSession(sessionId);
    if (!session) {
        // TUI worker hasn't connected yet — store link for later
        await setPendingRunnerLink(sessionId, runnerId);
        return;
    }

    await updateSessionFields(sessionId, {
        runnerId,
        runnerName: runner.name,
    });

    // Store a durable runner association that survives server restarts.
    // The session hash is deleted on relay disconnect, but this TTL key
    // persists so reconnecting TUI agents can restore their runner link.
    await setRunnerAssociation(sessionId, runnerId, runner.name);

    // Also persist the runner link in SQLite so historical/pinned sessions
    // retain their runner provenance after the Redis session hash is deleted.
    void updateRelaySessionRunner(sessionId, runnerId, runner.name).catch((error) => {
        log.error("Failed to persist runner link to SQLite:", error);
    });

    const heartbeat = session.lastHeartbeat ? safeJsonParse(session.lastHeartbeat) : null;

    await broadcastToHub(
        "session_status",
        {
            sessionId,
            isActive: session.isActive,
            lastHeartbeatAt: session.lastHeartbeatAt,
            sessionName: session.sessionName,
            model: modelFromHeartbeat(heartbeat),
            runnerId,
            runnerName: runner.name,
        },
        session.userId ?? undefined,
    );
}

/** Remove a runner session association. */
export async function removeRunnerSession(runnerId: string, sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    if (session && session.runnerId === runnerId) {
        await updateSessionFields(sessionId, { runnerId: null, runnerName: null });
        await deleteRunnerAssociation(sessionId);
    }
}

/**
 * Return sessions that are still connected to the relay and belong to the given runner.
 * Used after a runner daemon restart to let it re-adopt orphaned worker processes.
 */
export async function getConnectedSessionsForRunner(runnerId: string): Promise<Array<{ sessionId: string; cwd: string }>> {
    const allSessions = await getAllSessionSummaries();
    const results: Array<{ sessionId: string; cwd: string }> = [];
    for (const s of allSessions) {
        if (s.runnerId !== runnerId) continue;
        // Only include sessions whose TUI socket is still connected (worker is alive)
        const tuiSocket = localTuiSockets.get(s.sessionId);
        if (tuiSocket && tuiSocket.connected) {
            results.push({ sessionId: s.sessionId, cwd: s.cwd });
        }
    }
    return results;
}

/**
 * Convert a single RedisRunnerData to RunnerInfo for WS broadcast.
 * sessionCount is set to 0 — the client computes it from live sessions.
 */
function runnerDataToInfo(r: RedisRunnerData): RunnerInfo {
    const serviceIds: string[] | undefined = r.serviceIds ? safeJsonParse(r.serviceIds) ?? undefined : undefined;
    const panels = r.panels ? safeJsonParse(r.panels) ?? undefined : undefined;
    const triggerDefs = r.triggerDefs ? safeJsonParse(r.triggerDefs) ?? undefined : undefined;
    const sigilDefs = r.sigilDefs ? safeJsonParse(r.sigilDefs) ?? undefined : undefined;
    const warnings: string[] | undefined = r.warnings ? safeJsonParse(r.warnings) ?? undefined : undefined;
    return {
        runnerId: r.runnerId,
        name: r.name,
        roots: safeJsonParse(r.roots) ?? [],
        sessionCount: 0,
        skills: safeJsonParse(r.skills) ?? [],
        agents: safeJsonParse(r.agents ?? "[]") ?? [],
        plugins: safeJsonParse(r.plugins ?? "[]") ?? [],
        hooks: safeJsonParse(r.hooks ?? "[]") ?? [],
        version: r.version ?? null,
        platform: r.platform ?? null,
        ...(serviceIds ? { serviceIds } : {}),
        ...(panels ? { panels } : {}),
        ...(triggerDefs && triggerDefs.length > 0 ? { triggerDefs } : {}),
        ...(sigilDefs && sigilDefs.length > 0 ? { sigilDefs } : {}),
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
}

/** Get all runners as RunnerInfo, optionally filtered by user. */
export async function getRunners(filterUserId?: string): Promise<RunnerInfo[]> {
    const [runners, allSessions] = await Promise.all([
        getAllRunners(filterUserId),
        getAllSessionSummaries(filterUserId),
    ]);

    // Aggregate session counts by runnerId in memory
    const sessionCounts = new Map<string, number>();
    for (const s of allSessions) {
        if (s.runnerId) {
            sessionCounts.set(s.runnerId, (sessionCounts.get(s.runnerId) ?? 0) + 1);
        }
    }

    const results: RunnerInfo[] = [];

    for (const r of runners) {
        results.push({
            runnerId: r.runnerId,
            name: r.name,
            roots: safeJsonParse(r.roots) ?? [],
            sessionCount: sessionCounts.get(r.runnerId) ?? 0,
            skills: safeJsonParse(r.skills) ?? [],
            agents: safeJsonParse(r.agents ?? "[]") ?? [],
            plugins: safeJsonParse(r.plugins ?? "[]") ?? [],
            hooks: safeJsonParse(r.hooks ?? "[]") ?? [],
            version: r.version ?? null,
            platform: r.platform ?? null,
        });
    }

    return results;
}

/** Get a single runner's data. */
export async function getRunnerData(runnerId: string): Promise<RedisRunnerData | null> {
    return getRunnerState(runnerId);
}

/** Get the local runner socket (only on the server that owns the connection). */
export function getLocalRunnerSocket(runnerId: string): Socket | undefined {
    return localRunnerSockets.get(runnerId);
}

/** Remove a runner from Redis and local socket map. */
export async function removeRunner(runnerId: string): Promise<void> {
    // Read userId before deleting so we can target the correct user room
    const existing = await getRunnerState(runnerId);
    localRunnerSockets.delete(runnerId);
    await deleteRunnerState(runnerId);
    if (existing) {
        void broadcastToRunnersNs(
            "runner_removed",
            { runnerId },
            existing.userId ?? undefined,
        );
    }
}

/** Refresh a runner's TTL in Redis (call on heartbeat/activity). */
export async function touchRunner(runnerId: string): Promise<void> {
    await refreshRunnerTTL(runnerId);
}

/**
 * Sweep runners in Redis that have no live Socket.IO connection on ANY
 * server node.  This catches "ghost" runners preserved during a graceful
 * shutdown when the runner never reconnected — e.g. the runner process
 * was also stopped, or the server was shut down permanently rather than
 * restarted.
 *
 * Uses the Socket.IO Redis adapter's cluster-wide room query so that
 * in multi-node deployments a runner connected to a different relay
 * node is NOT pruned.
 *
 * Called once after a startup grace period to give runners time to
 * reconnect before being pruned.
 */
export async function sweepOrphanedRunners(): Promise<void> {
    const io = getIo();
    if (!io) {
        log.warn("Socket.IO not initialized — skipping sweep");
        return;
    }
    const allRunners = await getAllRunners();
    const runnerNs = io.of("/runner");
    let pruned = 0;
    for (const runner of allRunners) {
        // Check cluster-wide: is any socket in this runner's room?
        // adapter.fetchSockets queries all nodes via the Redis adapter.
        try {
            const sockets = await runnerNs.in(runnerRoom(runner.runnerId)).fetchSockets();
            if (sockets.length > 0) continue; // runner is alive on some node
        } catch {
            // If the adapter query fails (e.g. Redis issue), skip this
            // runner rather than risk pruning a live one.
            continue;
        }

        log.info(`Pruning orphaned runner ${runner.runnerId} (${runner.name ?? "unnamed"}) — not reconnected after restart`);
        await deleteRunnerState(runner.runnerId);
        void broadcastToRunnersNs(
            "runner_removed",
            { runnerId: runner.runnerId },
            runner.userId ?? undefined,
        );
        pruned++;
    }
    if (pruned > 0) {
        log.info(`Pruned ${pruned} orphaned runner(s)`);
    }
}
