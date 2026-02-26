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
} from "@pizzapi/protocol";
import { apiKeyAuthMiddleware } from "./auth.js";
import {
    registerRunner,
    updateRunnerSkills,
    publishSessionEvent,
    recordRunnerSession,
    linkSessionToRunner,
    removeRunnerSession,
    removeRunner,
    getLocalRunnerSocket,
    sendToTerminalViewer,
    removeTerminal,
    getTerminalIdsForRunner,
    getTerminalEntry,
    getConnectedSessionsForRunner,
} from "../sio-registry.js";
import { resolveSpawnReady, resolveSpawnError } from "../runner-control.js";

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

// ── Generic runner command request/response ──────────────────────────────────
// Maps requestId → { resolve, timer }. Used for file explorer / git commands.

interface PendingRunnerCommand {
    resolve: (result: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingRunnerCommands = new Map<string, PendingRunnerCommand>();

/**
 * Send a generic command to a runner via Socket.IO and wait for the response.
 * Returns the runner's file_result payload or throws on timeout.
 *
 * The command object must include a `type` field that maps to the event name
 * (e.g. "list_files", "read_file", "git_status", "git_diff").
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

        pendingRunnerCommands.set(requestId, { resolve, timer });

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

    runner.on("connection", (socket) => {
        console.log(`[sio/runner] connected: ${socket.id}`);

        // ── register_runner ──────────────────────────────────────────────────
        socket.on("register_runner", async (data) => {
            const name = data.name ?? null;
            const roots = data.roots ?? [];
            const requestedRunnerId = data.runnerId;
            const runnerSecret = data.runnerSecret;
            const skills = data.skills ?? [];

            const result = await registerRunner(socket, {
                name,
                roots,
                requestedRunnerId,
                runnerSecret,
                skills,
                userId: (socket.data as RunnerSocketData & { userId?: string }).userId ?? null,
                userName: (socket.data as RunnerSocketData & { userName?: string }).userName ?? null,
            });

            if (result instanceof Error) {
                socket.emit("error", { message: result.message });
                socket.disconnect(true);
                return;
            }

            socket.data.runnerId = result;

            // Look up sessions still connected to the relay that belong to this runner.
            // This allows the daemon to re-adopt orphaned worker processes after a restart.
            const existingSessions = await getConnectedSessionsForRunner(result);
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

        // ── file_result — runner responds to file/git commands ───────────────
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
            }
        });

        // ── Terminal PTY events from runner → browser viewer ─────────────────

        socket.on("terminal_ready", (data) => {
            const terminalId = data.terminalId;
            if (!terminalId) return;
            console.log(
                `[sio/runner] terminal_ready terminalId=${terminalId} runnerId=${socket.data.runnerId}`,
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
            console.log(
                `[sio/runner] terminal_exit terminalId=${terminalId} exitCode=${data.exitCode} runnerId=${socket.data.runnerId}`,
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
            console.warn(
                `[sio/runner] terminal_error terminalId=${terminalId} message="${data.message}" runnerId=${socket.data.runnerId}`,
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

        // ── disconnect — clean up runner resources ───────────────────────────
        socket.on("disconnect", async (reason) => {
            console.log(`[sio/runner] disconnected: ${socket.id} (${reason})`);
            const runnerId = socket.data.runnerId;
            if (runnerId) {
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
