/**
 * MockViewer — test harness client for the /viewer Socket.IO namespace.
 *
 * Connects with cookie-based auth, auto-collects events, and exposes
 * waitFor helpers for integration tests.
 */

import { io as clientIo, type Socket as ClientSocket } from "socket.io-client";
import type {
    ViewerServerToClientEvents,
    ViewerClientToServerEvents,
    Attachment,
} from "@pizzapi/protocol";
import type { TestServer } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReceivedEvent {
    event: unknown;
    seq?: number;
    replay?: boolean;
}

export interface MockViewer {
    socket: ClientSocket<ViewerServerToClientEvents, ViewerClientToServerEvents>;
    sessionId: string;

    // Send actions
    sendInput(text: string, attachments?: Attachment[]): void;
    sendExec(id: string, command: string): void;
    sendTriggerResponse(
        triggerId: string,
        response: string,
        targetSessionId: string,
        action?: string,
    ): void;
    sendResync(): void;

    // Received events
    getReceivedEvents(): ReceivedEvent[];
    clearEvents(): void;
    waitForEvent(
        predicate?: (evt: unknown) => boolean,
        timeout?: number,
    ): Promise<unknown>;
    waitForDisconnected(timeout?: number): Promise<string>;

    disconnect(): Promise<void>;
}

export interface MockViewerOptions {
    /** Timeout (ms) waiting for the initial `connected` event. Default: 5000 */
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

async function attemptViewerConnection(
    server: TestServer,
    sessionId: string,
    connectTimeout: number,
): Promise<ClientSocket<ViewerServerToClientEvents, ViewerClientToServerEvents>> {
    const socket: ClientSocket<ViewerServerToClientEvents, ViewerClientToServerEvents> =
        clientIo(`${server.baseUrl}/viewer`, {
            extraHeaders: { cookie: server.sessionCookie },
            query: { sessionId },
            transports: ["websocket"],
            autoConnect: false,
            // Disable auto-reconnect: if the connection fails, fail fast rather
            // than silently retrying and leaving a lingering socket open.
            reconnection: false,
        });

    const connectedPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.disconnect();
            reject(
                new Error(
                    `MockViewer: timeout waiting for connected event (${connectTimeout}ms) for session ${sessionId}`,
                ),
            );
        }, connectTimeout);

        socket.once("connected", () => {
            clearTimeout(timer);
            resolve();
        });

        // Server-emitted error event (e.g. "Session not found")
        socket.once("error", (data: { message: string }) => {
            clearTimeout(timer);
            socket.disconnect();
            reject(new Error(`MockViewer: server error on connect: ${data.message}`));
        });

        // Transport-level rejection (e.g. auth middleware returned unauthorized)
        socket.once("connect_error", (err) => {
            clearTimeout(timer);
            socket.disconnect();
            reject(new Error(`MockViewer: connect_error: ${err.message}`));
        });
    });

    socket.connect();

    // Send the viewer greeting after the underlying transport connects
    socket.once("connect", () => {
        socket.emit("connected", {});
    });

    await connectedPromise;
    return socket;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a MockViewer connected to the given test server and session.
 *
 * The promise resolves once the server sends the `connected` event,
 * confirming the viewer is successfully joined to the session.
 *
 * The first connection attempt may fail with `connect_error: unauthorized`
 * due to better-auth cold-start (lazy prepared-statement caching). Up to
 * `maxAttempts` retries are made with a 150 ms delay between attempts.
 */
export async function createMockViewer(
    server: TestServer,
    sessionId: string,
    opts?: MockViewerOptions,
): Promise<MockViewer> {
    const connectTimeout = opts?.connectTimeout ?? 5000;
    const maxAttempts = opts?.maxAttempts ?? 2;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            await new Promise<void>((r) => setTimeout(r, 150));
        }
        try {
            const socket = await attemptViewerConnection(server, sessionId, connectTimeout);
            return buildMockViewer(socket, sessionId);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// Build MockViewer from an already-connected socket
// ---------------------------------------------------------------------------

function buildMockViewer(
    socket: ClientSocket<ViewerServerToClientEvents, ViewerClientToServerEvents>,
    sessionId: string,
): MockViewer {
    // Collected events from the server
    const receivedEvents: ReceivedEvent[] = [];

    // Pending waitForEvent resolvers
    const eventWaiters: Array<{
        predicate?: (evt: unknown) => boolean;
        resolve: (evt: unknown) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];

    // Pending waitForDisconnected resolvers
    const disconnectWaiters: Array<{
        resolve: (reason: string) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];

    // Auto-collect all `event` payloads
    socket.on("event", (data) => {
        const entry: ReceivedEvent = {
            event: data.event,
            seq: data.seq,
            replay: data.replay,
        };
        receivedEvents.push(entry);

        // Notify waitForEvent callers
        for (let i = eventWaiters.length - 1; i >= 0; i--) {
            const waiter = eventWaiters[i];
            if (!waiter.predicate || waiter.predicate(data.event)) {
                clearTimeout(waiter.timer);
                eventWaiters.splice(i, 1);
                waiter.resolve(data.event);
            }
        }
    });

    // Handle disconnected events from server
    socket.on("disconnected", (data) => {
        for (let i = disconnectWaiters.length - 1; i >= 0; i--) {
            const waiter = disconnectWaiters[i];
            clearTimeout(waiter.timer);
            disconnectWaiters.splice(i, 1);
            waiter.resolve(data.reason);
        }
    });

    // ── MockViewer implementation ──────────────────────────────────────────

    const viewer: MockViewer = {
        socket,
        sessionId,

        sendInput(text: string, attachments?: Attachment[]): void {
            socket.emit("input", { text, attachments });
        },

        sendExec(id: string, command: string): void {
            socket.emit("exec", { id, command });
        },

        sendTriggerResponse(
            triggerId: string,
            response: string,
            targetSessionId: string,
            action?: string,
        ): void {
            socket.emit("trigger_response", { triggerId, response, targetSessionId, action }, () => {
                // ack callback — no-op for tests unless explicitly tested
            });
        },

        sendResync(): void {
            socket.emit("resync", {});
        },

        getReceivedEvents(): ReceivedEvent[] {
            return [...receivedEvents];
        },

        clearEvents(): void {
            receivedEvents.length = 0;
        },

        waitForEvent(
            predicate?: (evt: unknown) => boolean,
            timeout = 5000,
        ): Promise<unknown> {
            // Check if already buffered
            const existing = receivedEvents.find(
                (e) => !predicate || predicate(e.event),
            );
            if (existing) return Promise.resolve(existing.event);

            return new Promise<unknown>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = eventWaiters.findIndex((w) => w.resolve === resolve);
                    if (idx !== -1) eventWaiters.splice(idx, 1);
                    reject(new Error(`MockViewer.waitForEvent: timeout (${timeout}ms)`));
                }, timeout);

                eventWaiters.push({ predicate, resolve, reject, timer });
            });
        },

        waitForDisconnected(timeout = 5000): Promise<string> {
            return new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = disconnectWaiters.findIndex((w) => w.resolve === resolve);
                    if (idx !== -1) disconnectWaiters.splice(idx, 1);
                    reject(new Error(`MockViewer.waitForDisconnected: timeout (${timeout}ms)`));
                }, timeout);

                disconnectWaiters.push({ resolve, reject, timer });
            });
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

    return viewer;
}
