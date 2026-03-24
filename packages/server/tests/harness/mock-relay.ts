/**
 * MockRelay — socket.io-client connected to the /relay namespace.
 * Provides helpers for registering sessions and emitting agent events
 * in integration tests.
 */

import { io as connectSocket } from "socket.io-client";
import type { TestServer } from "./types.js";
import type { MockRelay, MockRelayOptions, MockRelaySession } from "./types.js";

/**
 * Create a MockRelay connected to the given test server's /relay namespace.
 *
 * The relay namespace is used by running agent sessions to register themselves
 * and stream events to viewers. This mock lets tests simulate a relay client —
 * registering sessions, emitting agent events, sending triggers, and sending
 * inter-session messages.
 *
 * The returned object's socket uses `reconnection: false` so cleanup
 * (io.close) can complete without the client reconnecting.
 *
 * @param server - The test server to connect to.
 * @param _opts  - Reserved for future options; currently unused.
 * @returns A connected MockRelay ready to register sessions and emit events.
 *
 * @example
 * ```ts
 * const relay = await createMockRelay(server);
 * const { sessionId, token } = await relay.registerSession({ cwd: "/project" });
 * relay.emitEvent(sessionId, token, buildHeartbeat({ active: true }), 0);
 * await relay.disconnect();
 * ```
 */
export async function createMockRelay(
    server: TestServer,
    _opts?: MockRelayOptions,
): Promise<MockRelay> {
    const socket = connectSocket(`${server.baseUrl}/relay`, {
        auth: { apiKey: server.apiKey },
        transports: ["websocket"],
        autoConnect: true,
        // Disable reconnection so cleanup (io.close) can complete.
        // If reconnection is on, the client immediately reconnects after
        // force-disconnect, preventing httpServer.close() from resolving.
        reconnection: false,
    });

    // Wait for the socket to connect
    await new Promise<void>((resolve, reject) => {
        if (socket.connected) {
            resolve();
            return;
        }
        const onConnect = () => {
            socket.off("connect_error", onError);
            resolve();
        };
        const onError = (err: Error) => {
            socket.off("connect", onConnect);
            reject(err);
        };
        socket.once("connect", onConnect);
        socket.once("connect_error", onError);
    });

    // Serial queue — ensures only one registerSession call is in-flight at a time.
    // Concurrent calls on the same socket would both receive the first "registered"
    // event, causing one call to get wrong data and the other to be dropped.
    let _registerLock: Promise<unknown> = Promise.resolve();

    function waitForEvent(eventName: string, timeout = 5000): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            const handler = (data: unknown) => {
                clearTimeout(timer);
                resolve(data);
            };

            const timer = setTimeout(() => {
                socket.off(eventName, handler);
                reject(new Error(`Timed out waiting for event: ${eventName}`));
            }, timeout);

            socket.once(eventName, handler);
        });
    }

    async function registerSession(opts?: {
        sessionId?: string;
        cwd?: string;
        ephemeral?: boolean;
        collabMode?: boolean;
        sessionName?: string | null;
        parentSessionId?: string | null;
    }): Promise<MockRelaySession> {
        // Serialize via _registerLock: only one registration may be in-flight at a time.
        // Without this, concurrent calls would both listen for the first "registered" event,
        // causing one call to receive the other's session data.
        const doRegister = async (): Promise<MockRelaySession> => {
            const registeredPromise = waitForEvent("registered");

            socket.emit("register", {
                sessionId: opts?.sessionId,
                cwd: opts?.cwd ?? "/tmp/mock-session",
                ephemeral: opts?.ephemeral ?? true,
                collabMode: opts?.collabMode ?? false,
                sessionName: opts?.sessionName ?? null,
                parentSessionId: opts?.parentSessionId ?? null,
            });

            const data = await registeredPromise as {
                sessionId: string;
                token: string;
                shareUrl: string;
            };

            return {
                sessionId: data.sessionId,
                token: data.token,
                shareUrl: data.shareUrl,
            };
        };

        // Chain this call onto the lock; swallow errors so failures don't jam the queue.
        const result = _registerLock.then(doRegister, doRegister);
        _registerLock = result.then(() => {}, () => {});
        return result;
    }

    function emitEvent(sessionId: string, token: string, event: unknown, seq?: number): void {
        socket.emit("event", {
            sessionId,
            token,
            event,
            ...(seq !== undefined ? { seq } : {}),
        });
    }

    function emitSessionEnd(sessionId: string, token: string): void {
        socket.emit("session_end", { sessionId, token });
    }

    function emitTrigger(data: {
        token: string;
        trigger: {
            type: string;
            sourceSessionId: string;
            targetSessionId: string;
            payload: Record<string, unknown>;
            deliverAs: "steer" | "followUp";
            expectsResponse: boolean;
            triggerId: string;
            ts: string;
        };
    }): void {
        socket.emit("session_trigger", data);
    }

    function emitTriggerResponse(data: {
        token: string;
        triggerId: string;
        response: string;
        action?: string;
        targetSessionId: string;
    }): void {
        socket.emit("trigger_response", data);
    }

    function emitSessionMessage(data: {
        token: string;
        targetSessionId: string;
        message: string;
        deliverAs?: "input";
    }): void {
        socket.emit("session_message", data);
    }

    async function disconnect(): Promise<void> {
        if (socket.connected) {
            await new Promise<void>((resolve) => {
                socket.once("disconnect", () => resolve());
                socket.disconnect();
            });
        }
        // Wait briefly for the underlying TCP connection to fully tear down.
        // Bun's http.Server.close() waits for all open connections to drain;
        // without this pause, httpServer.close() can hang because the WebSocket
        // TCP connection is still in FIN_WAIT state even after the socket-level
        // disconnect event fires.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    return {
        socket,
        registerSession,
        emitEvent,
        emitSessionEnd,
        emitTrigger,
        emitTriggerResponse,
        emitSessionMessage,
        waitForEvent,
        disconnect,
    };
}
