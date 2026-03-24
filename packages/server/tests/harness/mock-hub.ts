/**
 * MockHubClient — test harness client for the /hub Socket.IO namespace.
 *
 * Connects with cookie-based auth, auto-updates session list from server
 * broadcasts, and exposes waitFor helpers for integration tests.
 */

import { io as clientIo, type Socket as ClientSocket } from "socket.io-client";
import type {
    HubServerToClientEvents,
    HubClientToServerEvents,
    SessionInfo,
} from "@pizzapi/protocol";
import type { TestServer } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockHubClient {
    socket: ClientSocket<HubServerToClientEvents, HubClientToServerEvents>;
    sessions: SessionInfo[];

    waitForSessionAdded(
        predicate?: (s: SessionInfo) => boolean,
        timeout?: number,
    ): Promise<SessionInfo>;
    waitForSessionRemoved(sessionId: string, timeout?: number): Promise<void>;
    waitForSessionStatus(
        sessionId: string,
        predicate?: (data: unknown) => boolean,
        timeout?: number,
    ): Promise<unknown>;
    subscribeSessionMeta(sessionId: string): void;
    unsubscribeSessionMeta(sessionId: string): void;

    disconnect(): Promise<void>;
}

export interface MockHubClientOptions {
    /** Timeout (ms) waiting for the initial `sessions` snapshot. Default: 5000 */
    connectTimeout?: number;
    /**
     * Max connection attempts before giving up. Default: 2.
     * The first attempt sometimes fails with `connect_error: unauthorized`
     * due to better-auth cold-start (lazy prepared-statement caching).
     * A retry after a short delay reliably succeeds.
     */
    maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Internal: single connection attempt
// ---------------------------------------------------------------------------

async function attemptHubConnection(
    server: TestServer,
    connectTimeout: number,
): Promise<{ socket: ClientSocket<HubServerToClientEvents, HubClientToServerEvents>; initialSessions: SessionInfo[] }> {
    const socket: ClientSocket<HubServerToClientEvents, HubClientToServerEvents> =
        clientIo(`${server.baseUrl}/hub`, {
            extraHeaders: { cookie: server.sessionCookie },
            transports: ["websocket"],
            autoConnect: false,
            // Disable auto-reconnect: if the connection fails, fail fast rather
            // than silently retrying and leaving a lingering socket open.
            reconnection: false,
        });

    let initialSessions: SessionInfo[] = [];

    const snapshotPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.disconnect();
            reject(
                new Error(
                    `MockHubClient: timeout waiting for initial sessions snapshot (${connectTimeout}ms)`,
                ),
            );
        }, connectTimeout);

        socket.once("sessions", (data) => {
            clearTimeout(timer);
            initialSessions = data.sessions;
            resolve();
        });

        socket.once("connect_error", (err) => {
            clearTimeout(timer);
            socket.disconnect();
            reject(new Error(`MockHubClient: connection error: ${err.message}`));
        });
    });

    socket.connect();
    await snapshotPromise;
    return { socket, initialSessions };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a MockHubClient connected to the given test server.
 *
 * The promise resolves once the server sends the initial `sessions` snapshot.
 *
 * The first connection attempt may fail with `connect_error: unauthorized`
 * due to better-auth cold-start (lazy prepared-statement caching). Up to
 * `maxAttempts` retries are made with a 150 ms delay between attempts.
 */
export async function createMockHubClient(
    server: TestServer,
    opts?: MockHubClientOptions,
): Promise<MockHubClient> {
    const connectTimeout = opts?.connectTimeout ?? 5000;
    const maxAttempts = opts?.maxAttempts ?? 2;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            await new Promise<void>((r) => setTimeout(r, 150));
        }
        try {
            const { socket, initialSessions } = await attemptHubConnection(server, connectTimeout);
            return buildMockHubClient(socket, initialSessions);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// Build MockHubClient from an already-connected socket
// ---------------------------------------------------------------------------

function buildMockHubClient(
    socket: ClientSocket<HubServerToClientEvents, HubClientToServerEvents>,
    initialSessions: SessionInfo[],
): MockHubClient {

    // Mutable live sessions list — seeded with the initial snapshot
    const sessions: SessionInfo[] = [...initialSessions];

    // Pending waitForSessionAdded resolvers
    const addedWaiters: Array<{
        predicate?: (s: SessionInfo) => boolean;
        resolve: (s: SessionInfo) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];

    // Pending waitForSessionRemoved resolvers: keyed by sessionId
    const removedWaiters: Map<
        string,
        Array<{
            resolve: () => void;
            reject: (err: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }>
    > = new Map();

    // Pending waitForSessionStatus resolvers: keyed by sessionId
    const statusWaiters: Map<
        string,
        Array<{
            predicate?: (data: unknown) => boolean;
            resolve: (data: unknown) => void;
            reject: (err: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }>
    > = new Map();

    // ── Server event handlers ──────────────────────────────────────────────

    // Re-snapshot (e.g. after resync) — replaces the local sessions list
    socket.on("sessions", (data) => {
        sessions.length = 0;
        for (const s of data.sessions) sessions.push(s);
    });

    socket.on("session_added", (data) => {
        // Upsert in case of duplicate adds
        const idx = sessions.findIndex((s) => s.sessionId === data.sessionId);
        if (idx === -1) {
            sessions.push(data);
        } else {
            sessions[idx] = data;
        }

        // Notify waitForSessionAdded waiters
        for (let i = addedWaiters.length - 1; i >= 0; i--) {
            const waiter = addedWaiters[i];
            if (!waiter.predicate || waiter.predicate(data)) {
                clearTimeout(waiter.timer);
                addedWaiters.splice(i, 1);
                waiter.resolve(data);
            }
        }
    });

    socket.on("session_removed", (data) => {
        const idx = sessions.findIndex((s) => s.sessionId === data.sessionId);
        if (idx !== -1) sessions.splice(idx, 1);

        // Notify waitForSessionRemoved waiters
        const waiters = removedWaiters.get(data.sessionId);
        if (waiters) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.resolve();
            }
            removedWaiters.delete(data.sessionId);
        }
    });

    socket.on("session_status", (data) => {
        // Update local session if present
        const idx = sessions.findIndex((s) => s.sessionId === data.sessionId);
        if (idx !== -1) {
            sessions[idx] = {
                ...sessions[idx],
                isActive: data.isActive,
                lastHeartbeatAt: data.lastHeartbeatAt,
                sessionName: data.sessionName,
                model: data.model,
                runnerId: data.runnerId ?? sessions[idx].runnerId,
                runnerName: data.runnerName ?? sessions[idx].runnerName,
            };
        }

        // Notify waitForSessionStatus waiters
        const waiters = statusWaiters.get(data.sessionId);
        if (waiters) {
            for (let i = waiters.length - 1; i >= 0; i--) {
                const waiter = waiters[i];
                if (!waiter.predicate || waiter.predicate(data)) {
                    clearTimeout(waiter.timer);
                    waiters.splice(i, 1);
                    waiter.resolve(data);
                }
            }
            if (waiters.length === 0) statusWaiters.delete(data.sessionId);
        }
    });

    // ── MockHubClient implementation ───────────────────────────────────────

    const client: MockHubClient = {
        socket,
        sessions,

        waitForSessionAdded(
            predicate?: (s: SessionInfo) => boolean,
            timeout = 5000,
        ): Promise<SessionInfo> {
            // Check already-buffered sessions
            const existing = sessions.find((s) => !predicate || predicate(s));
            if (existing) return Promise.resolve(existing);

            return new Promise<SessionInfo>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = addedWaiters.findIndex((w) => w.resolve === resolve);
                    if (idx !== -1) addedWaiters.splice(idx, 1);
                    reject(new Error(`MockHubClient.waitForSessionAdded: timeout (${timeout}ms)`));
                }, timeout);

                addedWaiters.push({ predicate, resolve, reject, timer });
            });
        },

        waitForSessionRemoved(sessionId: string, timeout = 5000): Promise<void> {
            // Already removed?
            if (!sessions.find((s) => s.sessionId === sessionId)) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const list = removedWaiters.get(sessionId);
                    if (list) {
                        const idx = list.findIndex((w) => w.resolve === resolve);
                        if (idx !== -1) list.splice(idx, 1);
                    }
                    reject(
                        new Error(
                            `MockHubClient.waitForSessionRemoved: timeout (${timeout}ms) for session ${sessionId}`,
                        ),
                    );
                }, timeout);

                const list = removedWaiters.get(sessionId) ?? [];
                list.push({ resolve, reject, timer });
                removedWaiters.set(sessionId, list);
            });
        },

        waitForSessionStatus(
            sessionId: string,
            predicate?: (data: unknown) => boolean,
            timeout = 5000,
        ): Promise<unknown> {
            return new Promise<unknown>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const list = statusWaiters.get(sessionId);
                    if (list) {
                        const idx = list.findIndex((w) => w.resolve === resolve);
                        if (idx !== -1) list.splice(idx, 1);
                    }
                    reject(
                        new Error(
                            `MockHubClient.waitForSessionStatus: timeout (${timeout}ms) for session ${sessionId}`,
                        ),
                    );
                }, timeout);

                const list = statusWaiters.get(sessionId) ?? [];
                list.push({ predicate, resolve, reject, timer });
                statusWaiters.set(sessionId, list);
            });
        },

        subscribeSessionMeta(sessionId: string): void {
            socket.emit("subscribe_session_meta", { sessionId });
        },

        unsubscribeSessionMeta(sessionId: string): void {
            socket.emit("unsubscribe_session_meta", { sessionId });
        },

        disconnect(): Promise<void> {
            return new Promise<void>((resolve) => {
                if (!socket.connected) {
                    resolve();
                    return;
                }
                socket.once("disconnect", () => resolve());
                socket.disconnect();
            });
        },
    };

    return client;
}
