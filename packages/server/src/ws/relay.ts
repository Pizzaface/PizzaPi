import type { ServerWebSocket } from "bun";
import type { WsData } from "./registry.js";
import {
    addViewer,
    addHubClient,
    broadcastToViewers,
    endSharedSession,
    getSharedSession,
    getSessionState,
    getSessionSeq,
    getSessionLastHeartbeat,
    getSessions,
    getRunner,
    getTerminalEntry,
    getTerminalsForRunner,
    linkSessionToRunner,
    publishSessionEvent,
    recordRunnerSession,
    registerRunner,
    markTerminalSpawned,
    registerTerminal,
    registerTuiSession,
    removeHubClient,
    removeRunner,
    removeTerminal,
    removeTerminalViewer,
    sendToTerminalViewer,
    setTerminalViewer,
    removeRunnerSession,
    removeViewer,
    sendSnapshotToViewer,
    touchSessionActivity,
    updateSessionState,
    updateSessionHeartbeat,
    updateRunnerSkills,
    type RunnerSkill,
} from "./registry.js";

// ── Thinking-block duration tracking ─────────────────────────────────────────
// Keyed by sessionId → contentIndex → value.
// We record the wall-clock time when thinking_start arrives, compute elapsed
// seconds when thinking_end arrives, then bake durationSeconds into the
// message_end / turn_end event before it is published to Redis / viewers.
// That way the duration survives page reloads via the Redis replay path.

const thinkingStartTimes = new Map<string, Map<number, number>>();
const thinkingDurations  = new Map<string, Map<number, number>>();

function clearThinkingMaps(sessionId: string) {
    thinkingStartTimes.delete(sessionId);
    thinkingDurations.delete(sessionId);
}

/** Stamp `durationSeconds` onto thinking blocks in a message_end / turn_end event. */
function augmentMessageThinkingDurations(
    event: Record<string, unknown>,
    durations: Map<number, number>,
): Record<string, unknown> {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return event;
    let changed = false;
    const content = (message.content as unknown[]).map((block, i) => {
        if (!block || typeof block !== "object") return block;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking" && durations.has(i) && b.durationSeconds === undefined) {
            changed = true;
            return { ...b, durationSeconds: durations.get(i) };
        }
        return block;
    });
    if (!changed) return event;
    return { ...event, message: { ...message, content } };
}
import { getPersistedRelaySessionSnapshot } from "../sessions/store.js";
import { getCachedRelayEvents } from "../sessions/redis.js";
import { resolveSpawnError, resolveSpawnReady } from "./runner-control.js";
import { notifyAgentFinished, notifyAgentNeedsInput, notifyAgentError } from "../push.js";

// ── Skill request/response registry ──────────────────────────────────────────
// Maps requestId → { resolve, timer }. Used to correlate skill command
// responses (skill_result) from the runner back to the HTTP request handler.

interface PendingSkillRequest {
    resolve: (result: { ok: boolean; message?: string; skills?: RunnerSkill[]; content?: string; name?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingSkillRequests = new Map<string, PendingSkillRequest>();

/**
 * Send a skill command to a runner and wait for the response.
 * Returns the runner's skill_result payload or throws on timeout.
 */
export async function sendSkillCommand(
    runnerId: string,
    command: Record<string, unknown>,
    timeoutMs = 10_000,
): Promise<{ ok: boolean; message?: string; skills?: RunnerSkill[]; content?: string; name?: string }> {
    const runner = getRunner(runnerId);
    if (!runner) throw new Error("Runner not found");

    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingSkillRequests.delete(requestId);
            reject(new Error("Skill command timed out"));
        }, timeoutMs);

        pendingSkillRequests.set(requestId, { resolve, timer });

        try {
            runner.ws.send(JSON.stringify({ ...command, requestId }));
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
 * Send a generic command to a runner and wait for the response.
 * Returns the runner's file_result payload or throws on timeout.
 */
export async function sendRunnerCommand(
    runnerId: string,
    command: Record<string, unknown>,
    timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
    const runner = getRunner(runnerId);
    if (!runner) throw new Error("Runner not found");

    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRunnerCommands.delete(requestId);
            reject(new Error("Runner command timed out"));
        }, timeoutMs);

        pendingRunnerCommands.set(requestId, { resolve, timer });

        try {
            runner.ws.send(JSON.stringify({ ...command, requestId }));
        } catch (err) {
            clearTimeout(timer);
            pendingRunnerCommands.delete(requestId);
            reject(err);
        }
    });
}

function findLatestSnapshotEvent(cachedEvents: unknown[]): Record<string, unknown> | null {
    for (let i = cachedEvents.length - 1; i >= 0; i--) {
        const raw = cachedEvents[i];
        if (!raw || typeof raw !== "object") continue;
        const evt = raw as Record<string, unknown>;
        const type = typeof evt.type === "string" ? evt.type : "";

        // Prefer a full message list if present.
        if (type === "agent_end" && Array.isArray((evt as any).messages)) return evt;
        if (type === "session_active" && (evt as any).state !== undefined) return evt;
    }
    return null;
}

async function sendLatestSnapshotFromCache(ws: ServerWebSocket<WsData>, sessionId: string): Promise<boolean> {
    const cachedEvents = await getCachedRelayEvents(sessionId);
    if (cachedEvents.length === 0) return false;

    const snapshotEvent = findLatestSnapshotEvent(cachedEvents);
    if (!snapshotEvent) return false;

    try {
        ws.send(JSON.stringify({ type: "event", event: snapshotEvent, replay: true }));
        return true;
    } catch {
        return false;
    }
}

async function replayPersistedSnapshot(ws: ServerWebSocket<WsData>, sessionId: string) {
    try {
        ws.send(JSON.stringify({ type: "connected", sessionId, replayOnly: true }));

        // Fast path: instead of replaying the entire event buffer, try to send only the
        // latest session snapshot (last session_active / agent_end) so the UI can load
        // instantly from the newest state.
        const sentFromCache = await sendLatestSnapshotFromCache(ws, sessionId);

        if (!sentFromCache) {
            const snapshot = await getPersistedRelaySessionSnapshot(sessionId);
            if (!snapshot || snapshot.state === null || snapshot.state === undefined) {
                ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
                ws.close(1008, "Session not found");
                return;
            }

            ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: snapshot.state } }));
        }

        ws.send(JSON.stringify({ type: "disconnected", reason: "Session is no longer live (snapshot replay)." }));
        ws.close(1000, "Snapshot replay complete");
    } catch (error) {
        ws.send(JSON.stringify({ type: "error", message: "Failed to load session snapshot" }));
        ws.close(1011, "Failed to load session snapshot");
        console.error("Failed to replay persisted snapshot", error);
    }
}

/** Called when a WebSocket connection is opened. */
export function onOpen(ws: ServerWebSocket<WsData>) {
    // Role is set in the upgrade handler based on URL path.
    // TUI and runner connections perform a handshake via the first message.
    if (ws.data.role === "viewer" && ws.data.sessionId) {
        const sessionId = ws.data.sessionId;
        if (!getSharedSession(sessionId)) {
            void replayPersistedSnapshot(ws, sessionId);
            return;
        }

        const lastSeq = getSessionSeq(sessionId);
        const session = getSharedSession(sessionId);
        ws.send(JSON.stringify({
            type: "connected",
            sessionId,
            lastSeq,
            isActive: session?.isActive ?? false,
            lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
            sessionName: session?.sessionName ?? null,
        }));


        // Add viewer immediately so they don't miss subsequent live events.
        const ok = addViewer(sessionId, ws);
        if (!ok) {
            ws.send(JSON.stringify({ type: "disconnected", reason: "Session ended" }));
            ws.close(1000, "Session ended");
            return;
        }

        // Fast load: send only the latest snapshot (instead of replaying the full
        // Redis event buffer). The UI will render instantly from this state.
        const lastHeartbeat = getSessionLastHeartbeat(sessionId);
        if (lastHeartbeat) {
            try {
                ws.send(JSON.stringify({ type: "event", event: lastHeartbeat, seq: lastSeq }));
            } catch {}
        }

        const lastState = getSessionState(sessionId);
        if (lastState !== undefined) {
            try {
                ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: lastState }, seq: lastSeq }));
            } catch {}
        } else {
            // If we don't have an in-memory snapshot (e.g. relay restart), fall back
            // to the latest cached snapshot from Redis.
            void sendLatestSnapshotFromCache(ws, sessionId);
        }
    } else if (ws.data.role === "terminal" && ws.data.terminalId) {
        // Browser terminal viewer connecting — attach to the terminal entry
        const terminalId = ws.data.terminalId;
        console.log(`[terminal] viewer connected: terminalId=${terminalId} userId=${ws.data.userId}`);
        const entry = getTerminalEntry(terminalId);
        if (!entry) {
            console.warn(`[terminal] viewer connected but no terminal entry found: terminalId=${terminalId}`);
            ws.send(JSON.stringify({ type: "terminal_error", terminalId, message: "Terminal not found" }));
            ws.close(1008, "Terminal not found");
            return;
        }
        if (entry.userId !== ws.data.userId) {
            console.warn(`[terminal] viewer forbidden: terminalId=${terminalId} entry.userId=${entry.userId} viewer.userId=${ws.data.userId}`);
            ws.send(JSON.stringify({ type: "terminal_error", terminalId, message: "Forbidden" }));
            ws.close(1008, "Forbidden");
            return;
        }
        setTerminalViewer(terminalId, ws);
        console.log(`[terminal] viewer attached to runnerId=${entry.runnerId}: terminalId=${terminalId}`);
        ws.send(JSON.stringify({ type: "terminal_connected", terminalId }));
    } else if (ws.data.role === "hub") {
        addHubClient(ws);
        // Send only this user's active sessions on connect
        ws.send(JSON.stringify({ type: "sessions", sessions: getSessions(ws.data.userId) }));
    }
}

/** Called when a message arrives on a WebSocket. */
export function onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
    }

    if (ws.data.role === "tui") {
        handleTuiMessage(ws, msg);
    } else if (ws.data.role === "viewer") {
        handleViewerMessage(ws, msg);
    } else if (ws.data.role === "runner") {
        handleRunnerMessage(ws, msg);
    } else if (ws.data.role === "terminal") {
        handleTerminalViewerMessage(ws, msg);
    }
    // hub role: read-only feed, no inbound messages handled
}

/** Called when a WebSocket closes. */
export function onClose(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "tui" && ws.data.sessionId) {
        clearThinkingMaps(ws.data.sessionId);
        endSharedSession(ws.data.sessionId);
    } else if (ws.data.role === "viewer" && ws.data.sessionId) {
        removeViewer(ws.data.sessionId, ws);
    } else if (ws.data.role === "runner" && ws.data.runnerId) {
        // Clean up any terminals owned by this runner
        for (const tid of getTerminalsForRunner(ws.data.runnerId)) {
            sendToTerminalViewer(tid, { type: "terminal_exit", terminalId: tid, exitCode: -1 });
            removeTerminal(tid);
        }
        removeRunner(ws.data.runnerId);
    } else if (ws.data.role === "terminal" && ws.data.terminalId) {
        console.log(`[terminal] viewer disconnected: terminalId=${ws.data.terminalId} userId=${ws.data.userId}`);
        removeTerminalViewer(ws.data.terminalId, ws);
    } else if (ws.data.role === "hub") {
        removeHubClient(ws);
    }
}

// ── TUI message handling ──────────────────────────────────────────────────────

function sendCumulativeEventAck(ws: ServerWebSocket<WsData>, seq: number) {
    const previous = ws.data.lastAckedSeq ?? 0;
    const next = seq > previous ? seq : previous;
    ws.data.lastAckedSeq = next;

    try {
        ws.send(JSON.stringify({ type: "event_ack", sessionId: ws.data.sessionId, seq: next }));
    } catch {}
}

function handleTuiMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (msg.type === "register") {
        // TUI registers a shared session; sessionId is provided by CLI so reconnects preserve identity.
        const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
        const requestedSessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        const isEphemeral = msg.ephemeral !== false;
        const collabMode = msg.collabMode !== false;
        const sessionName =
            typeof msg.sessionName === "string"
                ? msg.sessionName
                : msg.sessionName === null
                  ? null
                  : undefined;
        const { sessionId, token, shareUrl } = registerTuiSession(ws, cwd, {
            sessionId: requestedSessionId,
            isEphemeral,
            collabMode,
            sessionName,
        });
        ws.data.sessionId = sessionId;
        ws.data.token = token;
        ws.data.lastAckedSeq = 0;
        ws.send(JSON.stringify({ type: "registered", sessionId, token, shareUrl, isEphemeral, collabMode }));
        return;
    }

    if (msg.type === "exec_result" && ws.data.sessionId) {
        broadcastToViewers(ws.data.sessionId, JSON.stringify(msg));
        return;
    }

    // ── Inter-session messaging ──────────────────────────────────────────────
    if (msg.type === "session_message") {
        // Validate sender token
        if (!ws.data.sessionId || msg.token !== ws.data.token) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            return;
        }
        const targetSessionId = typeof msg.targetSessionId === "string" ? msg.targetSessionId : "";
        const messageText = typeof msg.message === "string" ? msg.message : "";
        if (!targetSessionId || !messageText) {
            ws.send(JSON.stringify({ type: "error", message: "session_message requires targetSessionId and message" }));
            return;
        }
        const targetSession = getSharedSession(targetSessionId);
        if (!targetSession) {
            ws.send(JSON.stringify({
                type: "session_message_error",
                targetSessionId,
                error: "Target session not found or not connected",
            }));
            return;
        }
        // Forward the message to the target session's TUI WebSocket.
        try {
            targetSession.tuiWs.send(JSON.stringify({
                type: "session_message",
                fromSessionId: ws.data.sessionId,
                message: messageText,
                ts: new Date().toISOString(),
            }));
        } catch {
            ws.send(JSON.stringify({
                type: "session_message_error",
                targetSessionId,
                error: "Failed to deliver message to target session",
            }));
        }
        return;
    }

    if (msg.type === "event" || msg.type === "session_end") {
        // Validate token
        if (!ws.data.sessionId || msg.token !== ws.data.token) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            return;
        }

        if (msg.type === "session_end") {
            clearThinkingMaps(ws.data.sessionId);
            endSharedSession(ws.data.sessionId);
            ws.data.sessionId = undefined;
            ws.data.lastAckedSeq = undefined;
            return;
        }

        // Fast path: acknowledge receipt immediately (cumulative), before heavier work
        // like state transforms, Redis cache append, or viewer fanout.
        if (typeof msg.seq === "number" && Number.isFinite(msg.seq)) {
            sendCumulativeEventAck(ws, msg.seq);
        }

        // Cache session_active state so new viewers get an immediate snapshot
        const event = msg.event as Record<string, unknown> | undefined;
        if (event && event.type === "session_active") {
            updateSessionState(ws.data.sessionId, event.state);
        } else if (event && event.type === "heartbeat") {
            // Update liveness tracking from heartbeat — do not persist to Redis cache
            // (too chatty; viewers receive heartbeats via publishSessionEvent below).
            updateSessionHeartbeat(ws.data.sessionId, event);
        } else {
            touchSessionActivity(ws.data.sessionId);
        }

        // Track thinking-block timing so we can stamp durationSeconds on message_end.
        const sessionId = ws.data.sessionId;
        let eventToPublish: unknown = msg.event;

        if (event && event.type === "message_update") {
            const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (ae) {
                const deltaType = typeof ae.type === "string" ? ae.type : "";
                const contentIndex = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
                if (contentIndex >= 0) {
                    if (deltaType === "thinking_start") {
                        if (!thinkingStartTimes.has(sessionId)) thinkingStartTimes.set(sessionId, new Map());
                        thinkingStartTimes.get(sessionId)!.set(contentIndex, Date.now());
                    } else if (deltaType === "thinking_end") {
                        const startTime = thinkingStartTimes.get(sessionId)?.get(contentIndex);
                        if (startTime !== undefined) {
                            const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
                            if (!thinkingDurations.has(sessionId)) thinkingDurations.set(sessionId, new Map());
                            thinkingDurations.get(sessionId)!.set(contentIndex, durationSeconds);
                            thinkingStartTimes.get(sessionId)?.delete(contentIndex);
                        }
                    }
                }
            }
        }

        if (event && (event.type === "message_end" || event.type === "turn_end")) {
            const durations = thinkingDurations.get(sessionId);
            if (durations?.size) {
                eventToPublish = augmentMessageThinkingDurations(event, durations);
            }
            // Reset for the next assistant message.
            clearThinkingMaps(sessionId);
        }

        // Cache + forward event to viewers (for reconnect replay).
        publishSessionEvent(sessionId, eventToPublish);

        // ── Push notifications ─────────────────────────────────────────────────
        // Only send push when the user doesn't have an active browser viewer open.
        const sessionForPush = getSharedSession(sessionId);
        const userId = sessionForPush?.userId;
        const hasViewers = sessionForPush ? sessionForPush.viewers.size > 0 : false;

        if (userId && !hasViewers && event) {
            const sName = sessionForPush?.sessionName ?? null;

            // Agent finished working
            if (event.type === "agent_end") {
                notifyAgentFinished(userId, sessionId, sName);
            }

            // Agent is asking a question (AskUserQuestion tool)
            if (
                event.type === "tool_execution_start" &&
                event.toolName === "AskUserQuestion"
            ) {
                const args = event.args as Record<string, unknown> | undefined;
                const question = typeof args?.question === "string" ? args.question : undefined;
                notifyAgentNeedsInput(userId, sessionId, question, sName);
            }

            // CLI error
            if (event.type === "cli_error") {
                const errMsg = typeof event.message === "string" ? event.message : undefined;
                notifyAgentError(userId, sessionId, errMsg, sName);
            }
        }

        return;
    }
}

// ── Viewer message handling ───────────────────────────────────────────────────

function handleViewerMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (!ws.data.sessionId) return;

    const session = getSharedSession(ws.data.sessionId);
    if (!session) return;

    // Viewer requests a fresh snapshot (e.g. after detecting a sequence gap).
    if (msg.type === "resync") {
        sendSnapshotToViewer(ws.data.sessionId, ws);
        return;
    }

    // Notify TUI that a new viewer has connected so it can push capabilities.
    if (msg.type === "connected") {
        try {
            session.tuiWs.send(JSON.stringify({ type: "connected" }));
        } catch {}
        return;
    }

    // Collab mode: forward viewer input (+ optional attachments metadata) to TUI
    if (msg.type === "input" && session.collabMode && typeof msg.text === "string") {
        const attachments = Array.isArray(msg.attachments)
            ? msg.attachments
                  .filter((entry) => entry && typeof entry === "object")
                  .map((entry) => {
                      const item = entry as Record<string, unknown>;
                      return {
                          attachmentId: typeof item.attachmentId === "string" ? item.attachmentId : undefined,
                          mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
                          filename: typeof item.filename === "string" ? item.filename : undefined,
                          url: typeof item.url === "string" ? item.url : undefined,
                      };
                  })
                  .filter(
                      (item) =>
                          (typeof item.attachmentId === "string" && item.attachmentId.length > 0) ||
                          (typeof item.url === "string" && item.url.length > 0),
                  )
            : [];

        const client = typeof msg.client === "string" ? msg.client : undefined;
        const deliverAs = msg.deliverAs === "steer" || msg.deliverAs === "followUp" ? msg.deliverAs : undefined;

        try {
            session.tuiWs.send(JSON.stringify({ type: "input", text: msg.text, attachments, client, ...(deliverAs ? { deliverAs } : {}) }));
        } catch {}
        return;
    }

    if (
        msg.type === "model_set" &&
        session.collabMode &&
        typeof msg.provider === "string" &&
        typeof msg.modelId === "string"
    ) {
        try {
            session.tuiWs.send(JSON.stringify({ type: "model_set", provider: msg.provider, modelId: msg.modelId }));
        } catch {}
        return;
    }

    if (msg.type === "exec" && session.collabMode && typeof msg.id === "string" && typeof msg.command === "string") {
        try {
            session.tuiWs.send(JSON.stringify(msg));
        } catch {}
        return;
    }
}

// ── Runner message handling (Task 003) ───────────────────────────────────────

function handleRunnerMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (msg.type === "register_runner") {
        const name = typeof msg.name === "string" ? msg.name : null;
        const roots = Array.isArray(msg.roots)
            ? (msg.roots as unknown[]).filter((r): r is string => typeof r === "string")
            : [];
        const requestedRunnerId = typeof msg.runnerId === "string" ? msg.runnerId : undefined;
        const runnerSecret = typeof msg.runnerSecret === "string" ? msg.runnerSecret : undefined;
        const skills = Array.isArray(msg.skills) ? (msg.skills as unknown[]) : [];

        const result = registerRunner(ws, { name, roots, requestedRunnerId, runnerSecret, skills: skills as any });
        if (result instanceof Error) {
            ws.send(JSON.stringify({ type: "error", message: result.message }));
            ws.close(1008, result.message);
            return;
        }
        const runnerId = result;
        ws.data.runnerId = runnerId;
        ws.send(JSON.stringify({ type: "runner_registered", runnerId }));
        return;
    }

    // skills_list: runner responding to list_skills or reporting updated skills
    if (msg.type === "skills_list") {
        const runnerId = ws.data.runnerId;
        const skills = Array.isArray(msg.skills) ? (msg.skills as unknown[]) : [];
        if (runnerId) {
            updateRunnerSkills(runnerId, skills as any);
        }

        // Resolve pending request if any
        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (requestId) {
            const pending = pendingSkillRequests.get(requestId);
            if (pending) {
                clearTimeout(pending.timer);
                pendingSkillRequests.delete(requestId);
                pending.resolve({ ok: true, skills: skills as any });
            }
        }
        return;
    }

    // skill_result: runner responding to create/update/delete/get commands
    if (msg.type === "skill_result") {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (requestId) {
            const pending = pendingSkillRequests.get(requestId);
            if (pending) {
                clearTimeout(pending.timer);
                pendingSkillRequests.delete(requestId);
                pending.resolve({
                    ok: msg.ok === true,
                    message: typeof msg.message === "string" ? msg.message : undefined,
                    skills: Array.isArray(msg.skills) ? (msg.skills as any) : undefined,
                    content: typeof msg.content === "string" ? msg.content : undefined,
                    name: typeof msg.name === "string" ? msg.name : undefined,
                });
            }
        }

        // If the runner also sent an updated skills list, persist it
        if (ws.data.runnerId && Array.isArray(msg.skills)) {
            updateRunnerSkills(ws.data.runnerId, msg.skills as any);
        }
        return;
    }

    // file_result: runner responding to list_files / read_file / git_status / git_diff
    if (msg.type === "file_result") {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (requestId) {
            const pending = pendingRunnerCommands.get(requestId);
            if (pending) {
                clearTimeout(pending.timer);
                pendingRunnerCommands.delete(requestId);
                // Forward the entire message payload
                const { type: _type, requestId: _rid, runnerId: _rId, ...rest } = msg;
                pending.resolve(rest as Record<string, unknown>);
            }
        }
        return;
    }

    // Forward agent events from runner sessions to browser viewers
    if (msg.type === "runner_session_event") {
        const sessionId = msg.sessionId as string;
        publishSessionEvent(sessionId, msg.event);
        return;
    }

    // session_ready / session_error / session_killed / sessions_list — forward to web UI viewers if any
    if (msg.type === "session_ready" || msg.type === "session_error" || msg.type === "session_killed" || msg.type === "sessions_list") {
        const sessionId = msg.sessionId as string | undefined;
        const runnerId = ws.data.runnerId;

        if (runnerId && sessionId && msg.type === "session_ready") {
            recordRunnerSession(runnerId, sessionId);
            linkSessionToRunner(runnerId, sessionId);
            resolveSpawnReady(sessionId);
        }

        if (runnerId && sessionId && msg.type === "session_error") {
            const message = typeof (msg as any).message === "string" ? String((msg as any).message) : "Runner spawn failed";
            resolveSpawnError(sessionId, message);
        }

        if (runnerId && sessionId && msg.type === "session_killed") {
            removeRunnerSession(runnerId, sessionId);
        }

        if (sessionId) {
            broadcastToViewers(sessionId, JSON.stringify(msg));
        }
        return;
    }

    // ── Terminal PTY messages from runner → browser viewer ─────────────────
    if (msg.type === "terminal_ready" || msg.type === "terminal_data" || msg.type === "terminal_exit" || msg.type === "terminal_error") {
        const terminalId = typeof msg.terminalId === "string" ? msg.terminalId : "";
        if (!terminalId) {
            console.warn(`[terminal] handleRunnerMessage: missing terminalId in ${msg.type} from runnerId=${ws.data.runnerId}`);
            return;
        }

        const entry = getTerminalEntry(terminalId);

        if (msg.type === "terminal_ready") {
            console.log(`[terminal] runner→relay: terminal_ready terminalId=${terminalId} runnerId=${ws.data.runnerId} (viewer attached=${entry?.viewer != null})`);
        } else if (msg.type === "terminal_exit") {
            console.log(`[terminal] runner→relay: terminal_exit terminalId=${terminalId} exitCode=${msg.exitCode} runnerId=${ws.data.runnerId}`);
        } else if (msg.type === "terminal_error") {
            console.warn(`[terminal] runner→relay: terminal_error terminalId=${terminalId} message="${msg.message}" runnerId=${ws.data.runnerId}`);
        }
        // terminal_data is too chatty to log every message

        if (msg.type === "terminal_exit" || (msg.type === "terminal_error" && !entry)) {
            sendToTerminalViewer(terminalId, msg);
            removeTerminal(terminalId);
            return;
        }

        // Forward directly to the browser viewer
        sendToTerminalViewer(terminalId, msg);
        return;
    }
}

// ── Terminal viewer message handling ──────────────────────────────────────────

function handleTerminalViewerMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    const terminalId = ws.data.terminalId;
    if (!terminalId) {
        console.warn(`[terminal] handleTerminalViewerMessage: no terminalId on ws.data (msg.type=${msg.type})`);
        return;
    }

    const entry = getTerminalEntry(terminalId);
    if (!entry) {
        console.warn(`[terminal] handleTerminalViewerMessage: no entry for terminalId=${terminalId} (msg.type=${msg.type}) — message dropped`);
        return;
    }

    // Forward input/resize/kill to the runner that owns this terminal
    if (msg.type === "terminal_input" || msg.type === "terminal_resize" || msg.type === "kill_terminal") {
        const runner = getRunner(entry.runnerId);
        if (!runner) {
            console.warn(`[terminal] handleTerminalViewerMessage: runner not found runnerId=${entry.runnerId} for terminalId=${terminalId} (msg.type=${msg.type}) — message dropped`);
            return;
        }

        // Deferred spawn: if the PTY hasn't been spawned yet and we receive the
        // first terminal_resize from the viewer, use those dimensions to spawn.
        if (!entry.spawned && msg.type === "terminal_resize") {
            const cols = typeof msg.cols === "number" && msg.cols > 0 ? msg.cols : (entry.spawnOpts.cols ?? 80);
            const rows = typeof msg.rows === "number" && msg.rows > 0 ? msg.rows : (entry.spawnOpts.rows ?? 24);
            console.log(`[terminal] deferred spawn: viewer sent resize → spawning PTY terminalId=${terminalId} ${cols}x${rows} cwd=${entry.spawnOpts.cwd ?? "(default)"}`);
            markTerminalSpawned(terminalId);
            try {
                runner.ws.send(JSON.stringify({
                    type: "new_terminal",
                    terminalId,
                    cwd: entry.spawnOpts.cwd,
                    shell: entry.spawnOpts.shell,
                    cols,
                    rows,
                }));
            } catch (err) {
                console.error(`[terminal] deferred spawn: failed to send new_terminal to runner runnerId=${entry.runnerId} terminalId=${terminalId}:`, err);
                ws.send(JSON.stringify({ type: "terminal_error", terminalId, message: "Failed to spawn terminal" }));
            }
            return; // Don't forward the resize — the runner will use the dims from new_terminal
        }

        console.log(`[terminal] viewer→runner: terminalId=${terminalId} type=${msg.type}${msg.type === "terminal_resize" ? ` cols=${msg.cols} rows=${msg.rows}` : ""}`);
        try {
            runner.ws.send(JSON.stringify({ ...msg, terminalId }));
        } catch (err) {
            console.error(`[terminal] handleTerminalViewerMessage: failed to send to runner runnerId=${entry.runnerId} terminalId=${terminalId}:`, err);
        }
        return;
    }
}
