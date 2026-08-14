/**
 * Relay mirror for in-process subagents.
 *
 * Subagents run inside the parent worker (createAgentSession), so they never
 * register with the relay and only ever surfaced as an inline tool card. This
 * module registers each run as an ephemeral child session on the /relay
 * namespace — `parentSessionId` = the parent worker's session — which is the
 * exact same mechanism spawn_session children use. The web UI then nests them
 * in the sidebar tree and renders their transcript with no UI changes.
 *
 * Fire-and-forget: if the relay isn't configured (local TUI, no API key,
 * PIZZAPI_RELAY_URL=off) `createSubagentMirror` returns null and the subagent
 * runs exactly as before.
 */

import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import type { SingleResult } from "./types.js";

const log = createLogger("subagent-mirror");

/** Minimum gap between session_active snapshots, in ms. */
const SNAPSHOT_THROTTLE_MS = 1_000;

/** Newest-N transcript cap, so a runaway subagent can't blow up the socket.
 *  ponytail: flat cap, switch to the chunked-delivery path if it ever bites. */
const MAX_MIRRORED_MESSAGES = 200;

/** Liveness heartbeat cadence — same as the remote extension's. */
const HEARTBEAT_MS = 10_000;

/**
 * Live agent events forwarded verbatim, exactly as the remote extension
 * forwards them for a normal linked session, so the web UI streams token
 * deltas and tool cards instead of waiting for whole-message snapshots.
 * `agent_end` is deliberately excluded: its `messages` are run-scoped and both
 * the UI and the server treat them as a full snapshot (transcript truncation).
 */
const STREAMED_EVENTS = new Set([
    "agent_start",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
]);

export interface SubagentMirror {
    /** Relay session id of the mirrored child (exposed for tests/telemetry). */
    readonly sessionId: string;
    /** Forward a live agent event verbatim (streaming deltas, tool cards). */
    forward(event: { type?: string }): void;
    /** Report the resolved model so the UI shows a real provider/model chip. */
    setModel(model: MirrorModel | null): void;
    /** Push a transcript snapshot (throttled). */
    update(result: SingleResult): void;
    /** Push a final snapshot, end the relay session, and disconnect. */
    finish(result: SingleResult): void;
}

/** Model info as the web UI expects it (MetaModelInfo shape). */
export interface MirrorModel {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
}

export interface MirrorEnv {
    apiKey?: string;
    relayUrl?: string;
    socketIoUrl?: string;
    parentSessionId?: string;
}

/** Read relay connection settings from the worker's environment. */
export function readMirrorEnv(env: NodeJS.ProcessEnv = process.env): MirrorEnv {
    return {
        apiKey: env.PIZZAPI_API_KEY ?? env.PIZZAPI_API_TOKEN,
        relayUrl: env.PIZZAPI_RELAY_URL,
        socketIoUrl: env.PIZZAPI_SOCKETIO_URL,
        parentSessionId: env.PIZZAPI_SESSION_ID,
    };
}

/**
 * Resolve the Socket.IO base URL (http/https) for the relay, or null when the
 * relay is unavailable or explicitly disabled.
 */
export function resolveSocketIoUrl(env: MirrorEnv): string | null {
    if (env.socketIoUrl?.trim()) return env.socketIoUrl.trim().replace(/\/$/, "");
    const configured = env.relayUrl?.trim();
    if (!configured || configured.toLowerCase() === "off") return null;
    return configured
        .replace(/^ws:/, "http:")
        .replace(/^wss:/, "https:")
        .replace(/\/$/, "");
}

/** The slice of a Socket.IO client this module uses. */
export interface MirrorSocket {
    on(event: string, cb: (arg?: any) => void): unknown;
    emit(event: string, payload: unknown): unknown;
    disconnect(): unknown;
    removeAllListeners(): unknown;
}

/** Socket factory seam — overridden in tests. */
export type SocketFactory = (url: string, apiKey: string) => MirrorSocket;

const defaultSocketFactory: SocketFactory = (url, apiKey): Socket =>
    io(`${url}/relay`, {
        auth: { apiKey, protocolVersion: SOCKET_PROTOCOL_VERSION },
        transports: ["websocket"],
        reconnection: false,
    });

export interface MirrorOptions {
    agentName: string;
    task: string;
    cwd: string;
    /** Step index for chained runs — appended to the session name. */
    step?: number;
    env?: MirrorEnv;
    socketFactory?: SocketFactory;
    now?: () => number;
}

function sessionNameFor(agentName: string, task: string, step?: number): string {
    const trimmed = task.trim().replace(/\s+/g, " ");
    const preview = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
    const prefix = step !== undefined ? `${agentName} #${step + 1}` : agentName;
    return preview ? `${prefix}: ${preview}` : prefix;
}

/**
 * Register a subagent run as an ephemeral relay child session.
 * Returns null when the relay isn't configured — callers should treat a null
 * mirror as "no mirroring", not an error.
 */
export function createSubagentMirror(opts: MirrorOptions): SubagentMirror | null {
    const env = opts.env ?? readMirrorEnv();
    const parentSessionId = env.parentSessionId?.trim();
    const apiKey = env.apiKey?.trim();
    const url = resolveSocketIoUrl(env);
    if (!parentSessionId || !apiKey || !url) return null;

    const sessionId = randomUUID();
    const sessionName = sessionNameFor(opts.agentName, opts.task, opts.step);
    const now = opts.now ?? Date.now;

    let socket: MirrorSocket;
    try {
        socket = (opts.socketFactory ?? defaultSocketFactory)(url, apiKey);
    } catch (err) {
        log.warn("failed to open relay socket for subagent mirror:", err);
        return null;
    }

    let token: string | null = null;
    let seq = 0;
    let closed = false;
    let lastSnapshotAt = 0;
    /** Snapshot held back by the throttle, flushed by the next update/finish. */
    let pending: SingleResult | null = null;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    const emit = (event: unknown) => {
        if (closed || !token) return;
        try {
            socket.emit("event", { sessionId, token, event, seq: ++seq });
        } catch (err) {
            log.warn("subagent mirror event failed:", err);
        }
    };

    let model: MirrorModel | null = null;

    const snapshot = (result: SingleResult, active: boolean) => {
        // Fall back to the id-only model the assistant messages report when the
        // caller never resolved one (e.g. session creation failed early).
        if (!model && result.model) model = { provider: "", id: result.model, name: result.model };
        emit({
            type: "session_active",
            state: {
                messages: result.messages.slice(-MAX_MIRRORED_MESSAGES),
                model,
                sessionName,
                cwd: opts.cwd,
                goal: null,
                todoList: [],
                availableModels: [],
                availableCommands: [],
            },
        });
        emit({
            type: "heartbeat",
            active,
            isCompacting: false,
            ts: now(),
            model,
            sessionName,
            uptime: null,
            cwd: opts.cwd,
        });
        emit({
            type: "token_usage_updated",
            tokenUsage: {
                input: result.usage.input,
                output: result.usage.output,
                cacheRead: result.usage.cacheRead,
                cacheWrite: result.usage.cacheWrite,
                cost: result.usage.cost,
                contextTokens: result.usage.contextTokens || null,
            },
            providerUsage: {},
        });
    };

    const clearThrottle = () => {
        if (throttleTimer !== null) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
        }
    };

    const flushPending = () => {
        throttleTimer = null;
        if (!pending) return;
        const result = pending;
        pending = null;
        lastSnapshotAt = now();
        snapshot(result, true);
    };

    socket.on("connect", () => {
        if (closed) return;
        socket.emit("register", {
            sessionId,
            cwd: opts.cwd,
            ephemeral: true,
            collabMode: false,
            sessionName,
            parentSessionId,
        });
    });

    socket.on("registered", (data: { token?: string }) => {
        if (closed) return;
        token = typeof data?.token === "string" ? data.token : null;
        // Flush whatever the subagent has produced while we were connecting.
        if (pending) flushPending();
    });

    // Keep the child session visibly alive between snapshots — a long tool call
    // would otherwise leave the UI without a heartbeat for minutes.
    const heartbeatTimer = setInterval(() => {
        if (closed || !token) return;
        emit({
            type: "heartbeat",
            active: true,
            isCompacting: false,
            ts: now(),
            model: null,
            sessionName,
            uptime: null,
            cwd: opts.cwd,
        });
    }, HEARTBEAT_MS);
    (heartbeatTimer as { unref?: () => void }).unref?.();

    socket.on("connect_error", (err: unknown) => {
        log.warn("subagent mirror connect failed:", err);
    });

    const teardown = () => {
        if (closed) return;
        closed = true;
        clearThrottle();
        clearInterval(heartbeatTimer);
        pending = null;
        try {
            socket.removeAllListeners();
            socket.disconnect();
        } catch {
            // Socket already gone — nothing to clean up.
        }
    };

    return {
        sessionId,
        forward(event) {
            if (closed || !event?.type || !STREAMED_EVENTS.has(event.type)) return;
            emit(event);
        },
        setModel(next) {
            if (closed) return;
            model = next;
            emit({ type: "model_changed", model: next });
        },
        update(result) {
            if (closed) return;
            pending = result;
            if (!token) return; // registration flush will pick it up
            const elapsed = now() - lastSnapshotAt;
            if (elapsed >= SNAPSHOT_THROTTLE_MS) {
                clearThrottle();
                flushPending();
            } else if (throttleTimer === null) {
                throttleTimer = setTimeout(flushPending, SNAPSHOT_THROTTLE_MS - elapsed);
                // Don't hold the process open for a throttled snapshot.
                (throttleTimer as { unref?: () => void }).unref?.();
            }
        },
        finish(result) {
            if (closed) return;
            clearThrottle();
            pending = null;
            snapshot(result, false);
            if (token) {
                try {
                    socket.emit("session_end", { sessionId, token });
                } catch {
                    // Best effort — teardown below still closes the socket.
                }
            }
            teardown();
        },
    };
}
