/**
 * Shared types for the test server harness.
 */

export interface TestServerOptions {
    /** Override base URL (default: auto from port) */
    baseUrl?: string;
    /** Listen on a specific port (default: 0 = OS-assigned ephemeral port) */
    port?: number;
    /** Extra trusted origins for CORS */
    trustedOrigins?: string[];
    /** Disable signup-after-first-user restriction (default: true = disabled) */
    disableSignupAfterFirstUser?: boolean;
}

export interface TestServer {
    /** Ephemeral port the server is listening on */
    port: number;
    /** Base URL: http://127.0.0.1:{port} */
    baseUrl: string;
    /** The Socket.IO server instance */
    io: import("socket.io").Server;
    /** Pre-created API key for auth */
    apiKey: string;
    /** Pre-created test user's ID */
    userId: string;
    /** Pre-created test user's name */
    userName: string;
    /** Pre-created test user's email */
    userEmail: string;
    /** Auth session cookie string for viewer/hub namespaces */
    sessionCookie: string;
    /** Helper: make an authenticated REST request */
    fetch(path: string, init?: RequestInit): Promise<Response>;
    /** Shut down everything and clean up */
    cleanup(): Promise<void>;
    /**
     * Simulate a `pizza web` restart in-place.
     *
     * - `graceful` (default `true`): sets `isServerShuttingDown` before
     *   disconnecting all Socket.IO clients, so disconnect handlers skip
     *   destructive Redis cleanup — exactly what happens on a real SIGTERM.
     * - `graceful: false`: simulates a crash restart — disconnects without
     *   setting the shutdown flag, so handlers DO wipe runner/session state.
     *
     * After the method resolves the HTTP server and Socket.IO are back up on
     * the same port and the `io` property reflects the new instance.
     * Connected runners and viewers need to reconnect manually (they
     * received a `disconnect` event during the restart window).
     */
    restart(opts?: { graceful?: boolean }): Promise<void>;
}

// ── MockRelay types ──────────────────────────────────────────────────────────

import type { Socket as ClientSocket } from "socket.io-client";

/** Options for `createMockRelay()`. */
export interface MockRelayOptions {
    /**
     * Force creation of a new socket.io-client Manager, bypassing the shared
     * Manager cache keyed on base URL.
     *
     * When `true`, the relay socket will use its own isolated TCP connection
     * rather than multiplexing over an existing one. This is required when
     * using `createMockRelay()` alongside `createMockHubClient()`: hub sockets
     * authenticate via HTTP cookies (`extraHeaders`) while relay sockets use
     * `auth: { apiKey }`. If both share a Manager, the relay namespace
     * handshake travels over a cookie-authenticated connection and the server's
     * relay middleware silently drops the connection.
     *
     * Defaults to `false`. Pass `true` whenever a hub socket is active at the
     * same time, or use `TestScenario` which sets this automatically.
     */
    forceNew?: boolean;
}

/** Session registration result returned by `MockRelay.registerSession()`. */
export interface MockRelaySession {
    /** Server-assigned session ID. */
    sessionId: string;
    /** Relay token required to emit events for this session. */
    token: string;
    /** Public share URL for the session. */
    shareUrl: string;
}

export interface MockRelay {
    socket: ClientSocket;

    /** Register a new session. Returns { sessionId, token, shareUrl } */
    registerSession(opts?: {
        sessionId?: string;
        cwd?: string;
        ephemeral?: boolean;
        collabMode?: boolean;
        sessionName?: string | null;
        parentSessionId?: string | null;
    }): Promise<MockRelaySession>;

    /** Send an agent event through the relay */
    emitEvent(sessionId: string, token: string, event: unknown, seq?: number): void;

    /** Signal session end */
    emitSessionEnd(sessionId: string, token: string): void;

    /** Fire a session trigger (child → parent) */
    emitTrigger(data: {
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
    }): void;

    /** Fire a trigger response (parent → child) */
    emitTriggerResponse(data: {
        token: string;
        triggerId: string;
        response: string;
        action?: string;
        targetSessionId: string;
    }): void;

    /** Send an inter-session message */
    emitSessionMessage(data: {
        token: string;
        targetSessionId: string;
        message: string;
        deliverAs?: "input";
    }): void;

    /** Wait for a specific event */
    waitForEvent(eventName: string, timeout?: number): Promise<unknown>;

    disconnect(): Promise<void>;
}
