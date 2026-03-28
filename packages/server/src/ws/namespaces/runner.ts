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
import { isSameServiceAnnounce } from "./runner.service-announce.js";
export { isSameServiceAnnounce };

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
    if (persisted) {
        runnerServiceAnnounce.set(runnerId, {
            serviceIds: persisted.serviceIds,
            panels: persisted.panels,
        });
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

            // Start periodic Redis TTL refresh for this runner
            if (runnerTtlTimer) clearInterval(runnerTtlTimer);
            runnerTtlTimer = setInterval(() => {
                void touchRunner(result);
            }, 30 * 60 * 1000); // every 30 minutes

            // Look up sessions still connected to the relay that belong to this runner.
            // This allows the daemon to re-adopt orphaned worker processes after a restart.
            const existingSessions = await getConnectedSessionsForRunner(result);

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
            }

            // Seed in-memory service announce cache from Redis.
            // On reconnect the runner will emit a fresh service_announce after
            // service init, but this ensures viewers connecting in the gap
            // between registration and announce still get service data.
            void seedServiceAnnounceCache(result).catch(() => {});

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

        // ── runner_session_event — forward agent events to viewers ───────────
        socket.on("runner_session_event", async (data) => {
            await publishSessionEvent(data.sessionId, data.event);
        });

        // ── session_ready — worker session connected ─────────────────────────
        socket.on("session_ready", async (data) => {
            const runnerId = socket.data.runnerId;
            if (runnerId && data.sessionId) {
                await recordRunnerSession(runnerId, data.sessionId);
                await linkSessionToRunner(runnerId, data.sessionId);
                resolveSpawnReady(data.sessionId);
                // Track this session for service_message broadcasting
                if (!runnerSessionIds.has(runnerId)) {
                    runnerSessionIds.set(runnerId, new Set());
                }
                runnerSessionIds.get(runnerId)!.add(data.sessionId);
            }
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
        socket.on("disconnect_session", (data) => {
            const sessionId = data.sessionId;
            if (!sessionId) return;

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

        socket.on("terminal_ready", (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            log.info(
                `terminal_ready terminalId=${terminalId} runnerId=${socket.data.runnerId}`,
            );
            sendToTerminalViewer(terminalId, {
                type: "terminal_ready",
                terminalId,
            });
        });

        socket.on("terminal_data", (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            sendToTerminalViewer(terminalId, {
                type: "terminal_data",
                terminalId,
                data: data.data,
            });
        });

        socket.on("terminal_exit", async (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            log.info(
                `terminal_exit terminalId=${terminalId} exitCode=${data.exitCode} runnerId=${socket.data.runnerId}`,
            );
            sendToTerminalViewer(terminalId, {
                type: "terminal_exit",
                terminalId,
                exitCode: data.exitCode,
            });
            await removeTerminal(terminalId);
        });

        socket.on("terminal_error", async (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            log.warn(
                `terminal_error terminalId=${terminalId} message="${data.message}" runnerId=${socket.data.runnerId}`,
            );
            const entry = await getTerminalEntry(terminalId);
            sendToTerminalViewer(terminalId, {
                type: "terminal_error",
                terminalId,
                message: data.message,
            });
            if (!entry) {
                await removeTerminal(terminalId);
            }
        });

        // ── Generic service message relay: runner → viewers ──────────────────
        // Forward service envelopes verbatim to all viewers watching sessions
        // on this runner. The relay does not inspect serviceId — it just routes.
        socket.on("service_message", (envelope: ServiceEnvelope) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;
            // If envelope carries a sessionId, route only to that session's viewers.
            // Otherwise broadcast to all sessions on this runner (e.g. push announcements).
            const targetSessionId = (envelope as ServiceEnvelope & { sessionId?: string }).sessionId;
            if (targetSessionId) {
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
        socket.on("service_announce", (data: ServiceAnnounceData) => {
            const runnerId = socket.data.runnerId;
            if (!runnerId) return;

            const previous = runnerServiceAnnounce.get(runnerId);
            // Skip no-op announces to avoid redundant Redis writes and fan-out
            // to every viewer on this runner when nothing actually changed.
            if (isSameServiceAnnounce(previous, data)) return;

            // Cache in memory for fast lookups
            runnerServiceAnnounce.set(runnerId, data);
            // Persist to Redis so the data survives server restarts
            void updateRunnerServices(runnerId, data.serviceIds, data.panels).catch((err) => {
                log.error(`failed to persist service_announce to Redis for ${runnerId}:`, err);
            });
            const sessionIds = runnerSessionIds.get(runnerId);
            if (!sessionIds || sessionIds.size === 0) return;
            for (const sessionId of sessionIds) {
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

                // Clean up local session tracking
                runnerSessionIds.delete(runnerId);
                runnerServiceAnnounce.delete(runnerId);
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
