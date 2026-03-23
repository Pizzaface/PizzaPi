// ============================================================================
// context.ts — Shared Socket.IO runtime state
//
// Houses:
//   - The Socket.IO server reference and its init function
//   - Per-server local socket Maps (not shareable via Redis)
//   - Room-name helpers used across all sibling modules
//   - Cluster-wide emit helpers (emitToRunner, emitToRelaySession, …)
//   - Cross-cutting utilities (safeJsonParse, nextEphemeralExpiry)
//   - Touch-throttle state
// ============================================================================

import type { Server as SocketIOServer, Socket } from "socket.io";
import type { ModelInfo } from "@pizzapi/protocol";
import { getEphemeralTtlMs } from "../../sessions/store.js";

// ── Socket.IO server reference ──────────────────────────────────────────────

let io: SocketIOServer;

/** Call once at startup after creating the Socket.IO server. */
export function initSioRegistry(socketIoServer: SocketIOServer): void {
    io = socketIoServer;
}

/** Access the Socket.IO server instance from sibling modules. */
export function getIo(): SocketIOServer {
    return io;
}

// ── Room name conventions ───────────────────────────────────────────────────

/** Room that all hub clients join (on the /hub namespace). */
export const HUB_ROOM = "hub";

/** Room for a specific user's hub feed (on the /hub namespace). */
export function hubUserRoom(userId: string): string {
    return `hub:user:${userId}`;
}

/** Room name for a specific user's /runners feed. */
export function runnersUserRoom(userId: string): string {
    return `runners:user:${userId}`;
}

/** Room that all viewers of a session join (on the /viewer namespace). */
export function viewerSessionRoom(sessionId: string): string {
    return `session:${sessionId}`;
}

/** Room that the TUI relay socket joins (on the /relay namespace). */
export function relaySessionRoom(sessionId: string): string {
    return `session:${sessionId}`;
}

/** Room for a specific terminal viewer (on the /terminal namespace). */
export function terminalRoom(terminalId: string): string {
    return `terminal:${terminalId}`;
}

/**
 * Room that a runner socket joins on the /runner namespace.
 * Enables cluster-wide emission to a specific runner via the Redis adapter,
 * so session_ended can reach the correct runner regardless of which relay node
 * handles the cleanup request.
 */
export function runnerRoom(runnerId: string): string {
    return `runner:${runnerId}`;
}

// ── Local socket references (per-server, NOT shared via Redis) ──────────────

/** TUI relay sockets: sessionId → Socket on /relay namespace. */
export const localTuiSockets = new Map<string, Socket>();

/** Runner sockets: runnerId → Socket on /runner namespace. */
export const localRunnerSockets = new Map<string, Socket>();

/** Terminal viewer sockets: terminalId → Set of Sockets on /terminal namespace.
 *  Multiple viewers per terminal are supported so that both the mobile overlay
 *  and the desktop panel (which React mounts simultaneously but CSS-hides one)
 *  both receive PTY data. */
export const localTerminalViewerSockets = new Map<string, Set<Socket>>();

/** Terminal data buffer: terminalId → buffered messages (replayed when viewer connects). */
export const localTerminalBuffers = new Map<string, unknown[]>();

/** Terminal GC timers: terminalId → timer handle. */
export const localTerminalGcTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Runner credential store (in-memory, per-server).
 * Maps runnerId → runnerSecret for persistent runner identity validation.
 * Matches the behavior of the existing registry.ts.
 */
export const runnerSecrets = new Map<string, string>();

// ── Touch-throttle state ─────────────────────────────────────────────────────

/** Throttle interval for touchSessionActivity to reduce DB writes. */
export const TOUCH_THROTTLE_MS = 2000;

/** Last time a session was touched: sessionId → timestamp (ms). */
export const lastTouchTimes = new Map<string, number>();

// ── Cluster-wide emit helpers ────────────────────────────────────────────────

/** Export for use in cleanup paths that need cluster-wide runner notification. */
export function emitToRunner(runnerId: string, eventName: string, data: unknown): void {
    if (!io) return;
    // Primary path: cluster-wide via per-runner room (joined on registration).
    // Reaches runners on any relay node through the Redis adapter.
    try {
        io.of("/runner")
            .to(runnerRoom(runnerId))
            .emit(eventName, data);
    } catch (err) {
        console.warn("[sio-registry] emitToRunner room emit failed:", (err as Error)?.message);
    }
    // Compatibility fallback: direct local socket emit.
    // Handles runners on this node that haven't joined the room yet
    // (e.g. older daemon versions during a rolling deploy, or runners that
    // connected before this server was upgraded).  The daemon's handler is
    // idempotent via endedSessionIds, so double-delivery is safe.
    const local = localRunnerSockets.get(runnerId);
    if (local?.connected) {
        try { local.emit(eventName, data); } catch { /* best-effort */ }
    }
}

/**
 * Emit an event to the relay session room (cluster-wide via Redis adapter).
 * This reaches the runner's relay socket regardless of which server instance
 * the callback lands on. Returns true if the emit was dispatched.
 */
export function emitToRelaySession(sessionId: string, eventName: string, data: unknown): boolean {
    if (!io) return false;
    try {
        io.of("/relay")
            .to(relaySessionRoom(sessionId))
            .emit(eventName, data);
        return true;
    } catch (err) {
        // Redis adapter publishes before local fan-out, so EPIPE drops the
        // event for local sockets too. Fall back to local-only delivery, but
        // only if the session's TUI socket is actually on this server —
        // otherwise the local room is empty and returning true would mislead
        // callers (e.g. MCP OAuth would consume the nonce for a dropped callback).
        console.warn("[sio-registry] emitToRelaySession failed, falling back to local:", (err as Error)?.message);
        if (!localTuiSockets.has(sessionId)) return false;
        try {
            io.of("/relay")
                .local
                .to(relaySessionRoom(sessionId))
                .emit(eventName, data);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Emit an event to the relay session room, but only if at least one socket
 * is actually in the room. Unlike `emitToRelaySession()`, this is async
 * because it uses `fetchSockets()` to verify room membership before emitting.
 * Returns true only if the emit reached at least one socket.
 *
 * Use this for delivery-critical paths (e.g. trigger responses) where
 * falsely reporting success would leave the client stuck.
 */
export async function emitToRelaySessionVerified(sessionId: string, eventName: string, data: unknown): Promise<boolean> {
    if (!io) return false;
    const room = relaySessionRoom(sessionId);
    try {
        // ⚡ Bolt: Fast check on adapter avoids fetching full RemoteSocket objects across cluster
        const sockets = await io.of("/relay").adapter.sockets(new Set([room]));
        if (sockets.size === 0) return false;
        io.of("/relay").to(room).emit(eventName, data);
        return true;
    } catch (err) {
        console.warn("[sio-registry] emitToRelaySessionVerified failed:", (err as Error)?.message);
        return false;
    }
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function nextEphemeralExpiry(): string {
    return new Date(Date.now() + getEphemeralTtlMs()).toISOString();
}

export function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * Emit an event to a relay session room and wait for the first ack callback.
 * Returns { hadListeners: true, acked: true } if at least one socket acknowledged.
 * Used for delivery-critical paths like parent_delinked where the caller needs
 * to know whether the target actually processed the event.
 */
export async function emitToRelaySessionAwaitingAck(
    sessionId: string,
    eventName: string,
    data: unknown,
    timeoutMs: number = 1_000,
): Promise<{ hadListeners: boolean; acked: boolean }> {
    if (!io) return { hadListeners: false, acked: false };
    const room = relaySessionRoom(sessionId);
    try {
        // ⚡ Bolt: Fast socket presence check via adapter.sockets() avoids expensive cluster-wide network overhead of fetchSockets()
        const sockets = await io.of("/relay").adapter.sockets(new Set([room]));
        if (sockets.size === 0) return { hadListeners: false, acked: false };

        // Cast needed: Socket.IO typed namespace doesn't expose the .timeout().emit()
        // ack pattern in its TypeScript interface. This is a valid Socket.IO v4 API.
        const relayNs = io.of("/relay") as any;
        const responses = await new Promise<unknown[]>((resolve, reject) => {
            relayNs.to(room).timeout(timeoutMs).emit(eventName, data, (err: unknown, ackResponses: unknown[] = []) => {
                if (Array.isArray(ackResponses) && ackResponses.length > 0) {
                    resolve(ackResponses);
                    return;
                }
                if (err) {
                    reject(err);
                    return;
                }
                resolve([]);
            });
        });

        return { hadListeners: true, acked: responses.length > 0 };
    } catch (err) {
        console.warn("[sio-registry] emitToRelaySessionAwaitingAck failed:", (err as Error)?.message);
        return { hadListeners: true, acked: false };
    }
}

/** Extract a ModelInfo from a raw heartbeat payload (or return null). */
export function modelFromHeartbeat(rawHeartbeat: unknown): ModelInfo | null {
    const hb = rawHeartbeat && typeof rawHeartbeat === "object"
        ? rawHeartbeat as Record<string, unknown>
        : null;
    const rawModel = hb?.model;
    if (!rawModel || typeof rawModel !== "object") return null;
    const m = rawModel as Record<string, unknown>;
    if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
    return {
        provider: m.provider,
        id: m.id,
        name: typeof m.name === "string" ? m.name : undefined,
    };
}
