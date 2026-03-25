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
    getAllSessions,
    setPendingRunnerLink,
    setRunnerAssociation,
    deleteRunnerAssociation,
} from "../sio-state.js";
import { updateRelaySessionRunner } from "../../sessions/store.js";
import type { RunnerInfo, RunnerSkill, RunnerAgent, RunnerHook } from "@pizzapi/protocol";
import {
    localTuiSockets,
    localRunnerSockets,
    runnerSecrets,
    runnerRoom,
    safeJsonParse,
    modelFromHeartbeat,
} from "./context.js";
import { broadcastToHub } from "./hub.js";
import { broadcastToRunnersNs } from "./runners-broadcast.js";

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
        console.error("[sio-registry] Failed to persist runner link to SQLite:", error);
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
    const allSessions = await getAllSessions();
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
    };
}

/** Get all runners as RunnerInfo, optionally filtered by user. */
export async function getRunners(filterUserId?: string): Promise<RunnerInfo[]> {
    const runners = await getAllRunners(filterUserId);
    const allSessions = await getAllSessions(filterUserId);

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
 * Sweep runners in Redis that have no live Socket.IO connection on this
 * server node.  This catches "ghost" runners preserved during a graceful
 * shutdown when the runner never reconnected — e.g. the runner process
 * was also stopped, or the server was shut down permanently rather than
 * restarted.
 *
 * Called once after a startup grace period to give runners time to
 * reconnect before being pruned.
 */
export async function sweepOrphanedRunners(): Promise<void> {
    const allRunners = await getAllRunners();
    let pruned = 0;
    for (const runner of allRunners) {
        if (!localRunnerSockets.has(runner.runnerId)) {
            console.log(`[sio-registry] Pruning orphaned runner ${runner.runnerId} (${runner.name ?? "unnamed"}) — not reconnected after restart`);
            await deleteRunnerState(runner.runnerId);
            void broadcastToRunnersNs(
                "runner_removed",
                { runnerId: runner.runnerId },
                runner.userId ?? undefined,
            );
            pruned++;
        }
    }
    if (pruned > 0) {
        console.log(`[sio-registry] Pruned ${pruned} orphaned runner(s)`);
    }
}
