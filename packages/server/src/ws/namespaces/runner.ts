// ============================================================================
// /runner namespace — Runner daemon ↔ Server
//
// Handles runner registration, session lifecycle (ready/error/killed),
// skill and file command request/response patterns, and terminal PTY
// forwarding to browser viewers.
//
// Exports sendSkillCommand() and sendRunnerCommand() for use by REST API
// routes (or other server modules) that need to communicate with runners
// via the Socket.IO path.
// ============================================================================

import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type {
    RunnerClientToServerEvents,
    RunnerServerToClientEvents,
    RunnerInterServerEvents,
    RunnerSocketData,
    RunnerSkill,
    RunnerAgent,
} from "@pizzapi/protocol";
import { shouldPreserveOnSocketDisconnect } from "../../health.js";
import { apiKeyAuthMiddleware } from "./auth.js";

// Inline definitions mirror packages/protocol/src/shared.ts.
// Using local aliases avoids a cross-worktree symlink resolution issue where
// node_modules/@pizzapi/protocol points to the main branch's dist, not this
// worktree's updated dist.
type ServiceEnvelope = { serviceId: string; type: string; requestId?: string; payload: unknown };
import {
    registerRunner,
    updateRunnerSkills,
    updateRunnerAgents,
    updateRunnerPlugins,
    publishSessionEvent,
    recordRunnerSession,
    linkSessionToRunner,
    removeRunnerSession,
    removeRunner,
    getLocalRunnerSocket,
    getLocalTuiSocket,
    sendToTerminalViewer,
    removeTerminal,
    getTerminalIdsForRunner,
    getTerminalEntry,
    getConnectedSessionsForRunner,
    touchRunner,
    broadcastToSessionViewers,
    emitToRelaySession,
    getSharedSession,
} from "../sio-registry.js";
import { resolveSpawnReady, resolveSpawnError } from "../runner-control.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/runner");

// ── Skill request/response registry ──────────────────────────────────────────
// Maps requestId → { resolve, timer }. Used to correlate skill command
// responses (skill_result) from the runner back to the HTTP request handler.

interface PendingSkillRequest {
    resolve: (result: {
        ok: boolean;
        message?: string;
        skills?: RunnerSkill[];
        content?: string;
        name?: string;
    }) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingSkillRequests = new Map<string, PendingSkillRequest>();

/**
 * Send a skill command to a runner via Socket.IO and wait for the response.
 * Returns the runner's skill_result payload or throws on timeout.
 *
 * The command object must include a `type` field that maps to the event name
 * (e.g. "list_skills", "create_skill", "get_skill", etc.).
 */
export async function sendSkillCommand(
    runnerId: string,
    command: Record<string, unknown>,
    timeoutMs = 10_000,
): Promise<{ ok: boolean; message?: string; skills?: RunnerSkill[]; content?: string; name?: string }> {
    const socket = getLocalRunnerSocket(runnerId);
    if (!socket) throw new Error("Runner not found");

    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const eventName = typeof command.type === "string" ? command.type : "";
    if (!eventName) throw new Error("Missing command type");

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingSkillRequests.delete(requestId);
            reject(new Error("Skill command timed out"));
        }, timeoutMs);

        pendingSkillRequests.set(requestId, { resolve, timer });

        try {
            const { type: _type, ...rest } = command;
            // Emit the typed event to the runner socket
            (socket as Socket).emit(eventName, { ...rest, requestId });
        } catch (err) {
            clearTimeout(timer);
            pendingSkillRequests.delete(requestId);
            reject(err);
        }
    });
}

// ── Agent request/response registry ──────────────────────────────────────────
// Maps requestId → { resolve, timer }. Used to correlate agent command
// responses (agent_result) from the runner back to the HTTP request handler.

interface PendingAgentRequest {
    resolve: (result: {
        ok: boolean;
        message?: string;
        agents?: RunnerAgent[];
        content?: string;
        name?: string;
    }) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingAgentRequests = new Map<string, PendingAgentRequest>();

/**
 * Send an agent command to a runner via Socket.IO and wait for the response.
 * Returns the runner's agent_result payload or throws on timeout.
 */
export async function sendAgentCommand(
    runnerId: string,
    command: Record<string, unknown>,
    timeoutMs = 10_000,
): Promise<{ ok: boolean; message?: string; agents?: RunnerAgent[]; content?: string; name?: string }> {
    const socket = getLocalRunnerSocket(runnerId);
    if (!socket) throw new Error("Runner not found");

    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const eventName = typeof command.type === "string" ? command.type : "";
    if (!eventName) throw new Error("Missing command type");

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingAgentRequests.delete(requestId);
            reject(new Error("Agent command timed out"));
        }, timeoutMs);

        pendingAgentRequests.set(requestId, { resolve, timer });

        try {
            const { type: _type, ...rest } = command;
            (socket as Socket).emit(eventName, { ...rest, requestId });
        } catch (err) {
            clearTimeout(timer);
            pendingAgentRequests.delete(requestId);
            reject(err);
        }
    });
}

// ── Generic runner command request/response ──────────────────────────────────
// Maps requestId → { resolve, timer }. Used for file explorer / git commands.

interface PendingRunnerCommand {
    resolve: (result: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingRunnerCommands = new Map<string, PendingRunnerCommand>();

/**
 * Send a generic command to a runner via Socket.IO and wait for the response.
 * Returns the runner's file_result payload or throws on timeout.
 *
 * The command object must include a `type` field that maps to the event name
 * (e.g. "list_files", "read_file", "search_files").
 */
export async function sendRunnerCommand(
    runnerId: string,
    command: Record<string, unknown>,
    timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
    const socket = getLocalRunnerSocket(runnerId);
    if (!socket) throw new Error("Runner not found");

    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const eventName = typeof command.type === "string" ? command.type : "";
    if (!eventName) throw new Error("Missing command type");

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRunnerCommands.delete(requestId);
            reject(new Error("Runner command timed out"));
        }, timeoutMs);

        pendingRunnerCommands.set(requestId, { resolve, reject, timer });

        try {
            const { type: _type, ...rest } = command;
            (socket as Socket).emit(eventName, { ...rest, requestId });
        } catch (err) {
            clearTimeout(timer);
            pendingRunnerCommands.delete(requestId);
            reject(err);
        }
    });
}

// ── Runner service announce cache ─────────────────────────────────────────────
// In-memory hot cache for service_announce payloads. Also persisted to Redis
// via updateRunnerServices() so late-joining viewers (or viewers after a server
// restart) can receive the data without waiting for a fresh announce.
import type { ServiceAnnounceData } from "@pizzapi/protocol";
import { updateRunnerServices, getRunnerServices, addRunnerWarning, clearRunnerWarnings } from "../sio-registry/index.js";
import { chooseServiceAnnounceSeed, isSameServiceAnnounce, shouldSkipServiceAnnounceFanout } from "./runner.service-announce.js";
export { chooseServiceAnnounceSeed, isSameServiceAnnounce, shouldSkipServiceAnnounceFanout };

const runnerServiceAnnounce = new Map<string, ServiceAnnounceData>();

/** Get cached service IDs for a runner (empty array if none). */
export function getRunnerServiceIds(runnerId: string): string[] {
    return runnerServiceAnnounce.get(runnerId)?.serviceIds ?? [];
}

/** Get the full cached service announce data for a runner (in-memory). */
export function getRunnerServiceAnnounce(runnerId: string): ServiceAnnounceData | null {
    return runnerServiceAnnounce.get(runnerId) ?? null;
}

/**
 * Load service announce data from Redis into the in-memory cache.
 * Called after runner registration to seed the cache from persisted data
 * (e.g. after a server restart when the runner reconnects).
 */
export async function seedServiceAnnounceCache(runnerId: string): Promise<void> {
    if (runnerServiceAnnounce.has(runnerId)) return; // already cached
    const persisted = await getRunnerServices(runnerId);
    const next = chooseServiceAnnounceSeed(
        runnerServiceAnnounce.get(runnerId),
        persisted
            ? {
                serviceIds: persisted.serviceIds,
                panels: persisted.panels,
                triggerDefs: persisted.triggerDefs,
                sigilDefs: persisted.sigilDefs,
            }
            : null,
    );
    if (next && !runnerServiceAnnounce.has(runnerId)) {
        runnerServiceAnnounce.set(runnerId, next);
    }
}

// ── Namespace registration ───────────────────────────────────────────────────

export function registerRunnerNamespace(io: SocketIOServer): void {
    const runner: Namespace<
        RunnerClientToServerEvents,
        RunnerServerToClientEvents,
        RunnerInterServerEvents,
        RunnerSocketData
    > = io.of("/runner");

    // Auth: validate API key from handshake
    runner.use(apiKeyAuthMiddleware() as Parameters<typeof runner.use>[0]);

    // ── Per-runner session tracking (in-memory) ──────────────────────────────
    // Maps runnerId → Set<sessionId>. Used to broadcast service_message and
    // service_announce to all viewers watching sessions on this runner.
    // This mirrors the session_ready / session_killed lifecycle already tracked
    // in Redis, but is kept in-memory here to avoid async Redis reads on every
    // service_message event (which may be high-frequency terminal output).
    const runnerSessionIds = new Map<string, Set<string>>();
    // Tracks whether this process has already fanned out a live
    // service_announce from the currently connected runner. Redis can seed
    // cached service metadata after a relay restart, but viewers still need
    // the first live announce to rehydrate service panels, triggers, and sigils.
    const runnerHasBroadcastLiveServiceAnnounce = new Set<string>();
    // Maps runnerId → Set<terminalId>. Mirrors terminal ownership already in
    // Redis but kept in-memory for fast O(1) checks on high-frequency
    // terminal_data events without a Redis round-trip per packet.
    // Entries are only added here AFTER the async Redis ownership check in
    // terminal_ready has confirmed the runner owns the terminal.
    const runnerTerminalIds = new Map<string, Set<string>>();
    // Maps terminalId → pending ownership check.  Set by terminal_ready
    // BEFORE the async Redis round-trip completes.  Consumers
    // (terminal_data / terminal_exit / terminal_error) await this promise
    // before forwarding events, closing the TOCTOU window that existed when
    // terminal IDs were optimistically written to runnerTerminalIds before
    // ownership was confirmed.  Resolved when ownership is verified; rejected
    // when ownership fails or the runner disconnects mid-check.
    const pendingTerminalChecks = new Map<string, { promise: Promise<void>; reject: () => void; runnerId: string }>();
    // Maps sessionId → pending ownership check.  Set by session_ready BEFORE
    // the async getSharedSession() call completes.  Consumers that check
    // runnerSessionIds (runner_session_event, disconnect_session,
    // service_message) await this promise before proceeding, closing the
    // TOCTOU window where those handlers would trust a not-yet-verified
    // session membership.  Resolved when user-ownership is confirmed;
    // rejected when ownership fails or the runner disconnects mid-check.
    const pendingSessionChecks = new Map<string, { promise: Promise<void>; reject: () => void; runnerId: string }>();

    runner.on("connection", (socket) => {
        log.info(`connected: ${socket.id}`);

        // ── Periodic Redis TTL refresh ───────────────────────────────────────
        // The runner's Redis key has a 2-hour TTL. Without periodic refresh,
        // idle runners (0 sessions, no skill changes) silently expire from
        // Redis while their Socket.IO connection stays alive — making them
        // appear disconnected in the UI.  Refresh every 30 minutes.
        let runnerTtlTimer: ReturnType<typeof setInterval> | null = null;

        // ── register_runner ──────────────────────────────────────────────────
        socket.on("register_runner", async (data) => {
            const name = data.name ?? null;
            const roots = data.roots ?? [];
            const requestedRunnerId = data.runnerId;
            const runnerSecret = data.runnerSecret;
            const skills = data.skills ?? [];
            const agents = data.agents ?? [];
            const plugins = data.plugins ?? [];
            const hooks = data.hooks ?? [];
            const version = data.version ?? null;
            const platform = typeof data.platform === "string" ? data.platform : null;

            const result = await registerRunner(socket, {
                name,
                roots,
                requestedRunnerId,
                runnerSecret,
                skills,
                agents,
                plugins,
                hooks,
                version,
                platform,
                userId: (socket.data as RunnerSocketData & { userId?: string }).userId ?? null,
                userName: (socket.data as RunnerSocketData & { userName?: string }).userName ?? null,
            });

            if (result instanceof Error) {
                socket.emit("error", { message: result.message });
                socket.disconnect(true);
                return;
            }

            socket.data.runnerId = result;
            runnerHasBroadcastLiveServiceAnnounce.delete(result);

            // Start periodic Redis TTL refresh for this runner
            if (runnerTtlTimer) clearInterval(runnerTtlTimer);
            runnerTtlTimer = setInterval(() => {
                void touchRunner(result);
            }, 30 * 60 * 1000); // every 30 minutes

            // Look up sessions still connected to the relay that belong to this runner.
            // This allows the daemon to re-adopt orphaned worker processes after a restart.
            const existingSessions = await getConnectedSessionsForRunner(result);
            log.info(`[runner reconnect] runner=${result} existingSessions=${existingSessions.length}`);

            // Seed runnerSessionIds so that service_message / service_announce
            // forwarding works immediately for sessions that existed before this
            // socket connection (e.g. after a daemon restart / reconnect).
            if (existingSessions.length > 0) {
                if (!runnerSessionIds.has(result)) {
                    runnerSessionIds.set(result, new Set());
                }
                const sessionSet = runnerSessionIds.get(result)!;
                for (const sid of existingSessions) {
                    sessionSet.add(sid.sessionId);
                }
                log.info(`[runner reconnect] runner=${result} seeded runnerSessionIds=[${Array.from(sessionSet).join(",")}]`);
            }

            // Seed runnerTerminalIds from Redis for this runner on reconnect
            // so terminal_data ownership checks work immediately for terminals
            // that were active before the runner/server restarted.
            const existingTerminalIds = await getTerminalIdsForRunner(result);
            if (existingTerminalIds.length > 0) {
                if (!runnerTerminalIds.has(result)) {
                    runnerTerminalIds.set(result, new Set());
                }
                const terminalSet = runnerTerminalIds.get(result)!;
                for (const tid of existingTerminalIds) {
                    terminalSet.add(tid);
                }
                log.info(`[runner reconnect] runner=${result} seeded runnerTerminalIds=[${existingTerminalIds.join(",")}]`);
            }

            // Seed in-memory service announce cache from Redis before the
            // runner proceeds with service init. This closes the gap where a
            // viewer can reconnect after runner registration but before the
            // fresh live service_announce arrives.
            await seedServiceAnnounceCache(result);

            socket.emit("runner_registered", {
                runnerId: result,
                ...(existingSessions.length > 0 ? { existingSessions } : {}),
            });
        });

        // ── skills_list — runner reports updated skills ──────────────────────
        socket.on("skills_list", async (data) => {
            const runnerId = socket.data.runnerId;
            const skills = data.skills ?? [];

            if (runnerId) {
                await updateRunnerSkills(runnerId, skills);
            }

            // Resolve pending skill request if any
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingSkillRequests.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingSkillRequests.delete(requestId);
                    pending.resolve({ ok: true, skills });
                }
            }
        });

        // ── skill_result — runner responds to skill CRUD ─────────────────────
        socket.on("skill_result", async (data) => {
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingSkillRequests.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingSkillRequests.delete(requestId);
                    pending.resolve({
                        ok: data.ok,
                        message: data.message,
                        skills: data.skills,
                        content: data.content,
                        name: data.name,
                    });
                }
            }

            // If the runner also sent an updated skills list, persist it
            if (socket.data.runnerId && data.skills) {
                await updateRunnerSkills(socket.data.runnerId, data.skills);
            }
        });

        // ── agents_list — runner reports updated agents ──────────────────────
        socket.on("agents_list", async (data) => {
            const runnerId = socket.data.runnerId;
            const agents = data.agents ?? [];

            if (runnerId) {
                await updateRunnerAgents(runnerId, agents);
            }

            // Resolve pending agent request if any
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingAgentRequests.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingAgentRequests.delete(requestId);
                    pending.resolve({ ok: true, agents });
                }
            }
        });

        // ── agent_result — runner responds to agent CRUD ─────────────────────
        socket.on("agent_result", async (data) => {
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingAgentRequests.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingAgentRequests.delete(requestId);
                    pending.resolve({
                        ok: data.ok,
                        message: data.message,
                        agents: data.agents,
                        content: data.content,
                        name: data.name,
                    });
                }
            }

            // If the runner also sent an updated agents list, persist it
            if (socket.data.runnerId && data.agents) {
                await updateRunnerAgents(socket.data.runnerId, data.agents);
            }
        });

        // ── plugins_list — runner reports discovered Claude Code plugins ─────
        socket.on("plugins_list", async (data) => {
            const runnerId = socket.data.runnerId;
            const plugins = data?.plugins ?? [];
            const scanOk = data?.ok !== false; // treat missing ok as success
            const isScoped = !!data?.scoped;

            if (runnerId && scanOk && !isScoped) {
                // Only update the runner-wide cache for unscoped (global) scans.
                // Per-cwd scans are one-off and shouldn't overwrite the baseline.
                await updateRunnerPlugins(runnerId, plugins);
            }

            // Resolve pending plugin request if any
            const requestId = data?.requestId;
            if (requestId) {
                const pending = pendingRunnerCommands.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRunnerCommands.delete(requestId);
                    pending.resolve({ ok: scanOk, plugins, message: data?.message });
                }
            }
        });

        // ── file_result — runner responds to file explorer commands ────────────
        socket.on("file_result", (data) => {
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingRunnerCommands.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRunnerCommands.delete(requestId);
                    const { requestId: _rid, ...rest } = data;
                    pending.resolve(rest);
                }
            }
        });

        // ── usage_data — respond with usage dashboard data ────────────────────
        socket.on("usage_data", (data) => {
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingRunnerCommands.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRunnerCommands.delete(requestId);
                    pending.resolve((data.data as Record<string, unknown>) ?? {});
                }
            }
        });

        // ── usage_error — usage data request failed ──────────────────────────
        socket.on("usage_error", (data) => {
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingRunnerCommands.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRunnerCommands.delete(requestId);
                    pending.reject(new Error(data.error ?? "Unknown usage error"));
                }
            }
        });

        // ── models_list — runner responds with available models ─────────────
        socket.on("models_list", (data) => {
            const requestId = data.requestId;
            if (requestId) {
                const pending = pendingRunnerCommands.get(requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRunnerCommands.delete(requestId);
                    const { requestId: _rid, ...rest } = data;
                    pending.resolve(rest);
                }
            }
        });

        // ── runner_session_event — forward agent events to viewers ───────────
        socket.on("runner_session_event", async (data) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            // If session_ready is still awaiting its ownership check, block here
            // until it resolves (owned) or rejects (not owned / disconnected).
            // This closes the TOCTOU window: no events are published before
            // ownership is confirmed.
            const pendingSession = pendingSessionChecks.get(data.sessionId);
            if (pendingSession) {
                try {
                    await pendingSession.promise;
                } catch {
                    // Ownership check failed or runner disconnected — drop.
                    return;
                }
            }
            // Security: verify the session belongs to this runner before publishing.
            // Prevents a compromised runner from injecting events into sessions it
            // doesn't own (same guard pattern used by service_message).
            if (!runnerSessionIds.get(runnerId)?.has(data.sessionId)) {
                log.warn(`runner_session_event rejected: session ${data.sessionId} not owned by runner ${runnerId}`);
                return;
            }
            await publishSessionEvent(data.sessionId, data.event);
        });

        // ── session_ready — worker session connected ─────────────────────────
        socket.on("session_ready", async (data) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId || !data.sessionId) return;
            // Guard against duplicate session_ready for the same session.
            if (pendingSessionChecks.has(data.sessionId) || runnerSessionIds.get(runnerId)?.has(data.sessionId)) {
                log.warn(`session_ready ignored: sessionId ${data.sessionId} already pending or verified for runner ${runnerId}`);
                return;
            }
            // Set up a pending-promise so runner_session_event / disconnect_session
            // / service_message events that race with the async ownership check
            // below will await this promise rather than being forwarded or dropped
            // based on a not-yet-verified session membership.
            // Nothing is written to runnerSessionIds yet — ownership is unconfirmed.
            let resolveCheck!: () => void;
            let rejectCheck!: () => void;
            const checkPromise = new Promise<void>((resolve, reject) => {
                resolveCheck = resolve;
                rejectCheck = reject;
            });
            // Attach a no-op catch immediately so that if rejectCheck() is called
            // before any handler is awaiting the promise (e.g. the runner disconnects
            // while the Redis check is in flight), Bun does not treat it as an
            // unhandled rejection and crash the process.
            checkPromise.catch(() => {});
            pendingSessionChecks.set(data.sessionId, { promise: checkPromise, reject: rejectCheck, runnerId });

            // Security: verify the session belongs to this runner's user.
            // Prevents a runner owned by user A from hijacking a session
            // owned by user B by sending a spurious session_ready.
            const runnerUserId = (socket.data as RunnerSocketData & { userId?: string }).userId;
            const session = await getSharedSession(data.sessionId);
            if (session?.userId && runnerUserId && session.userId !== runnerUserId) {
                log.warn(`session_ready rejected: session ${data.sessionId} belongs to user ${session.userId}, runner belongs to user ${runnerUserId}`);
                pendingSessionChecks.delete(data.sessionId);
                rejectCheck();
                return;
            }
            // Ownership confirmed.  If the runner disconnected while the check
            // was in flight the disconnect handler already called rejectCheck()
            // and deleted the pending entry — bail out to avoid creating a
            // dangling runnerSessionIds entry for a gone runner.
            if (!socket.connected) {
                pendingSessionChecks.delete(data.sessionId);
                // rejectCheck() may already have been called by disconnect handler;
                // calling it again is safe (Promise settle is idempotent).
                rejectCheck();
                return;
            }
            pendingSessionChecks.delete(data.sessionId);
            if (!runnerSessionIds.has(runnerId)) {
                runnerSessionIds.set(runnerId, new Set());
            }
            runnerSessionIds.get(runnerId)!.add(data.sessionId);
            resolveCheck();
            log.info(`session_ready sessionId=${data.sessionId} runnerId=${runnerId}`);
            await recordRunnerSession(runnerId, data.sessionId);
            await linkSessionToRunner(runnerId, data.sessionId);
            resolveSpawnReady(data.sessionId);
        });

        // ── session_error — worker session failed to spawn ───────────────────
        socket.on("session_error", (data) => {
            if (data.sessionId) {
                resolveSpawnError(data.sessionId, data.message ?? "Runner spawn failed");
            }
        });

        // ── session_killed — worker session terminated ───────────────────────
        socket.on("session_killed", async (data) => {
            const runnerId = socket.data.runnerId;
            if (runnerId && data.sessionId) {
                await removeRunnerSession(runnerId, data.sessionId);
                // Remove from local tracking
                runnerSessionIds.get(runnerId)?.delete(data.sessionId);
            }
        });

        // ── disconnect_session — runner asks relay to disconnect a worker ─────
        // Used to kill adopted sessions where the daemon has no child process handle.
        socket.on("disconnect_session", async (data) => {
            const sessionId = data.sessionId;
            if (!sessionId) return;

            // If session_ready is still awaiting its ownership check, block here
            // until it resolves (owned) or rejects (not owned / disconnected).
            const pendingSession = pendingSessionChecks.get(sessionId);
            if (pendingSession) {
                try {
                    await pendingSession.promise;
                } catch {
                    // Ownership check failed or runner disconnected — drop.
                    return;
                }
            }

            // Security: only allow disconnecting sessions owned by this runner.
            const runnerId = socket.data.runnerId;
            if (!runnerId || !runnerSessionIds.get(runnerId)?.has(sessionId)) {
                log.warn(`disconnect_session rejected: session ${sessionId} not owned by runner ${runnerId}`);
                return;
            }

            const tuiSocket = getLocalTuiSocket(sessionId);
            if (tuiSocket && tuiSocket.connected) {
                // Send an end_session exec command so the worker shuts down cleanly
                tuiSocket.emit("exec", {
                    id: `disconnect-${sessionId}-${Date.now()}`,
                    command: "end_session",
                });
                // Give the worker a moment to shut down gracefully, then force-disconnect
                setTimeout(() => {
                    if (tuiSocket.connected) {
                        tuiSocket.disconnect(true);
                    }
                }, 3_000);
            }
        });

        // ── Terminal PTY events from runner → browser viewer ─────────────────

        socket.on("terminal_ready", async (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            // Guard against duplicate terminal_ready for the same terminal.
            if (pendingTerminalChecks.has(terminalId) || runnerTerminalIds.get(runnerId)?.has(terminalId)) {
                log.warn(`terminal_ready ignored: terminalId ${terminalId} already pending or verified for runner ${runnerId}`);
                return;
            }
            // Set up a pending-promise so terminal_data/terminal_exit/terminal_error
            // events that race with the async Redis ownership check below will
            // await this promise rather than being silently forwarded or dropped.
            // Nothing is written to runnerTerminalIds yet — ownership is unconfirmed.
            let resolveCheck!: () => void;
            let rejectCheck!: () => void;
            const checkPromise = new Promise<void>((resolve, reject) => {
                resolveCheck = resolve;
                rejectCheck = reject;
            });
            // Attach a no-op catch immediately so that if rejectCheck() is called
            // before any handler is awaiting the promise (e.g. the runner disconnects
            // while the Redis check is in flight), Bun does not treat it as an
            // unhandled rejection and crash the process.  Awaiting callers still
            // receive the rejection through their own await.
            checkPromise.catch(() => {});
            pendingTerminalChecks.set(terminalId, { promise: checkPromise, reject: rejectCheck, runnerId });
            // Async Redis ownership check.
            const entry = await getTerminalEntry(terminalId);
            if (!entry || entry.runnerId !== runnerId) {
                log.warn(`terminal_ready rejected: terminalId ${terminalId} not owned by runner ${runnerId}`);
                pendingTerminalChecks.delete(terminalId);
                rejectCheck();
                return;
            }
            // Ownership confirmed.  If the runner disconnected while the check
            // was in flight the disconnect handler already called rejectCheck()
            // and deleted the pending entry — bail out to avoid creating a
            // dangling runnerTerminalIds entry for a gone runner.
            if (!socket.connected) {
                pendingTerminalChecks.delete(terminalId);
                // rejectCheck() may already have been called by disconnect handler;
                // calling it again is safe (Promise settle is idempotent).
                rejectCheck();
                return;
            }
            pendingTerminalChecks.delete(terminalId);
            if (!runnerTerminalIds.has(runnerId)) runnerTerminalIds.set(runnerId, new Set());
            runnerTerminalIds.get(runnerId)!.add(terminalId);
            resolveCheck();
            log.info(`terminal_ready terminalId=${terminalId} runnerId=${runnerId}`);
            sendToTerminalViewer(terminalId, {
                type: "terminal_ready",
                terminalId,
            });
        });

        socket.on("terminal_data", async (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            // If terminal_ready is still awaiting its Redis ownership check,
            // block here until it resolves (owned) or rejects (not owned).
            // This closes the TOCTOU window: no data is forwarded before
            // ownership is confirmed.
            const pending = pendingTerminalChecks.get(terminalId);
            if (pending) {
                try {
                    await pending.promise;
                } catch {
                    // Ownership check failed or runner disconnected — drop.
                    return;
                }
            }
            // Security: in-memory ownership check (populated after Redis
            // verification in terminal_ready, or seeded on runner reconnect).
            if (!runnerTerminalIds.get(runnerId)?.has(terminalId)) return;
            sendToTerminalViewer(terminalId, {
                type: "terminal_data",
                terminalId,
                data: data.data,
            });
        });

        socket.on("terminal_exit", async (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            // If terminal_ready is still awaiting its Redis ownership check,
            // block here until it resolves or rejects before deciding whether
            // to forward this event.
            const pending = pendingTerminalChecks.get(terminalId);
            if (pending) {
                try {
                    await pending.promise;
                } catch {
                    // Ownership check failed or runner disconnected — drop.
                    return;
                }
            }
            if (!runnerTerminalIds.get(runnerId)?.has(terminalId)) {
                log.warn(`terminal_exit rejected: terminalId ${terminalId} not owned by runner ${runnerId}`);
                return;
            }
            log.info(`terminal_exit terminalId=${terminalId} exitCode=${data.exitCode} runnerId=${runnerId}`);
            sendToTerminalViewer(terminalId, {
                type: "terminal_exit",
                terminalId,
                exitCode: data.exitCode,
            });
            runnerTerminalIds.get(runnerId)?.delete(terminalId);
            await removeTerminal(terminalId);
        });

        socket.on("terminal_error", async (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            const isInCache = runnerTerminalIds.get(runnerId)?.has(terminalId);
            const pending = pendingTerminalChecks.get(terminalId);
            if (pending) {
                // terminal_ready is in-flight — wait for the ownership check
                // before deciding whether to forward this error event.
                try {
                    await pending.promise;
                } catch {
                    // Ownership check failed or runner disconnected — drop.
                    return;
                }
                // Re-check cache after await; runner may have disconnected.
                if (!runnerTerminalIds.get(runnerId)?.has(terminalId)) return;
            } else if (!isInCache) {
                // terminal_error can arrive before terminal_ready when a PTY
                // fails to spawn — fall back to a Redis ownership check so
                // the failure signal is not silently dropped.
                const entry = await getTerminalEntry(terminalId);
                if (!entry || entry.runnerId !== runnerId) {
                    log.warn(`terminal_error rejected: terminalId ${terminalId} not owned by runner ${runnerId}`);
                    return;
                }
            }
            log.warn(`terminal_error terminalId=${terminalId} message="${data.message}" runnerId=${runnerId}`);
            sendToTerminalViewer(terminalId, {
                type: "terminal_error",
                terminalId,
                message: data.message,
            });
            // Cleanup: remove terminal from cache and Redis regardless of
            // whether it had a Redis entry — the terminal has failed.
            runnerTerminalIds.get(runnerId)?.delete(terminalId);
            await removeTerminal(terminalId);
        });

        // ── Generic service message relay: runner → viewers ──────────────────
        // Forward service envelopes verbatim to all viewers watching sessions
        // on this runner. The relay does not inspect serviceId — it just routes.
        socket.on("service_message", async (envelope: ServiceEnvelope) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            // If envelope carries a sessionId, route only to that session's viewers.
            // Otherwise broadcast to all sessions on this runner (e.g. push announcements).
            const targetSessionId = (envelope as ServiceEnvelope & { sessionId?: string }).sessionId;
            if (targetSessionId) {
                // If session_ready is still awaiting its ownership check, block here
                // until it resolves (owned) or rejects (not owned / disconnected).
                const pendingSession = pendingSessionChecks.get(targetSessionId);
                if (pendingSession) {
                    try {
                        await pendingSession.promise;
                    } catch {
                        // Ownership check failed or runner disconnected — drop.
                        return;
                    }
                }
                // Security: verify the target session belongs to this runner to prevent
                // cross-session injection by a compromised or malicious runner.
                if (!runnerSessionIds.get(runnerId)?.has(targetSessionId)) {
                    log.warn(`service_message rejected: session ${targetSessionId} not owned by runner ${runnerId}`);
                    return;
                }
                broadcastToSessionViewers(targetSessionId, "service_message", envelope);
                // Also route to the session's relay socket (TUI worker) so
                // agent-initiated service_message requests get their responses.
                emitToRelaySession(targetSessionId, "service_message", envelope);
            } else {
                const sessionIds = runnerSessionIds.get(runnerId);
                if (!sessionIds || sessionIds.size === 0) return;
                for (const sid of sessionIds) {
                    broadcastToSessionViewers(sid, "service_message", envelope);
                    emitToRelaySession(sid, "service_message", envelope);
                }
            }
        });

        // ── runner_warning — runner reports a warning (e.g. tunnel failure) ───
        socket.on("runner_warning", (data: { message: string }) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId || !data?.message) return;
            log.warn(`runner_warning from ${runnerId}: ${data.message}`);
            void addRunnerWarning(runnerId, data.message).catch((err) => {
                log.error(`failed to persist runner_warning for ${runnerId}:`, err);
            });
        });

        // ── runner_warning_clear — runner clears all warnings ────────────────
        socket.on("runner_warning_clear", () => {
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            void clearRunnerWarnings(runnerId).catch((err) => {
                log.error(`failed to clear warnings for ${runnerId}:`, err);
            });
        });

        // ── service_announce — runner announces available services ────────────
        // Forward to all viewers watching sessions on this runner so they know
        // which services are available.
        socket.on("service_announce", async (data: ServiceAnnounceData) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;

            const previous = runnerServiceAnnounce.get(runnerId);
            const sameAsCached = isSameServiceAnnounce(previous, data);
            // Skip redundant fanout only after this process has already
            // broadcast a live announce from the current runner connection.
            // After a relay restart the cache may be warm from Redis, but
            // viewers still need the first live announce to rehydrate.
            if (shouldSkipServiceAnnounceFanout({
                previous,
                next: data,
                hasBroadcastLiveAnnounce: runnerHasBroadcastLiveServiceAnnounce.has(runnerId),
            })) {
                log.info(`[service_announce] runner=${runnerId} skipped (no-op)`);
                return;
            }

            // Cache in memory for fast lookups
            runnerServiceAnnounce.set(runnerId, data);
            // Persist to Redis so the data survives server restarts.
            // Identical payloads can skip the write; viewers still need fanout.
            if (!sameAsCached) {
                void updateRunnerServices(runnerId, data.serviceIds, data.panels, data.triggerDefs, data.sigilDefs).catch((err) => {
                    log.error(`failed to persist service_announce to Redis for ${runnerId}:`, err);
                });
            }

            let sessionIds = runnerSessionIds.get(runnerId);
            log.info(`[service_announce] runner=${runnerId} initial sessionIds=${sessionIds ? Array.from(sessionIds).join(",") : "<none>"}`);

            // Fallback: after a server restart, the in-memory runnerSessionIds map
            // can be empty even though relay sessions for this runner are still
            // connected. Reseed from Redis instead of dropping the fresh announce.
            if (!sessionIds || sessionIds.size === 0) {
                const existingSessions = await getConnectedSessionsForRunner(runnerId);
                if (existingSessions.length > 0) {
                    const reseeded = new Set(existingSessions.map((s) => s.sessionId));
                    runnerSessionIds.set(runnerId, reseeded);
                    sessionIds = reseeded;
                    log.info(`[service_announce] runner=${runnerId} reseeded sessionIds=${Array.from(reseeded).join(",")}`);
                } else {
                    log.info(`[service_announce] runner=${runnerId} no connected sessions after fallback reseed`);
                }
            }

            if (!sessionIds || sessionIds.size === 0) return;
            runnerHasBroadcastLiveServiceAnnounce.add(runnerId);
            for (const sessionId of sessionIds) {
                log.info(`[service_announce] runner=${runnerId} fanout -> session=${sessionId}`);
                broadcastToSessionViewers(sessionId, "service_announce", data);
            }
        });

        // ── disconnect — clean up runner resources ───────────────────────────
        socket.on("disconnect", async (reason) => {
            log.info(`disconnected: ${socket.id} (${reason})`);
            if (runnerTtlTimer) {
                clearInterval(runnerTtlTimer);
                runnerTtlTimer = null;
            }
            const runnerId = socket.data.runnerId;
            if (runnerId) {
                // During graceful shutdown (io.close()), Socket.IO disconnects
                // all sockets with reason "server shutting down".  Skip
                // destructive Redis cleanup for those — the runner is still
                // alive and will reconnect to the new server instance.
                // We check BOTH the flag and the reason to avoid preserving
                // state for runners that genuinely crashed during the brief
                // shutdown window.
                if (shouldPreserveOnSocketDisconnect(reason)) {
                    log.info(`server shutting down — preserving Redis state for runner ${runnerId}`);
                    return;
                }

                // Clean up local session and terminal tracking
                runnerSessionIds.delete(runnerId);
                // Reject any pending session ownership checks for this runner so
                // that awaiting runner_session_event / disconnect_session /
                // service_message handlers unblock and drop their events
                // immediately instead of waiting for getSharedSession() to return.
                for (const [sessionId, entry] of pendingSessionChecks) {
                    if (entry.runnerId === runnerId) {
                        entry.reject();
                        pendingSessionChecks.delete(sessionId);
                    }
                }
                // Reject any pending terminal ownership checks for this runner so
                // that awaiting terminal_data/exit/error handlers unblock and drop
                // their events immediately instead of waiting for Redis.
                for (const [terminalId, entry] of pendingTerminalChecks) {
                    if (entry.runnerId === runnerId) {
                        entry.reject();
                        pendingTerminalChecks.delete(terminalId);
                    }
                }
                runnerTerminalIds.delete(runnerId);
                runnerServiceAnnounce.delete(runnerId);
                runnerHasBroadcastLiveServiceAnnounce.delete(runnerId);
                // Clean up any terminals owned by this runner
                const terminalIds = await getTerminalIdsForRunner(runnerId);
                for (const tid of terminalIds) {
                    sendToTerminalViewer(tid, {
                        type: "terminal_exit",
                        terminalId: tid,
                        exitCode: -1,
                    });
                    await removeTerminal(tid);
                }
                await removeRunner(runnerId);
            }
        });
    });
}
