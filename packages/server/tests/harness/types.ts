/**
 * Shared types for the test server harness.
 */

export interface TestServerOptions {
    /** Override base URL (default: auto from port) */
    baseUrl?: string;
    /** Extra trusted origins for CORS */
    trustedOrigins?: string[];
    /** Disable signup-after-first-user restriction (default: true = disabled) */
    disableSignupAfterFirstUser?: boolean;
}

export interface TestServer {
    /** Ephemeral port the server is listening on */
    port: number;
    /** Base URL: http://localhost:{port} */
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
}

// ── MockRelay types ──────────────────────────────────────────────────────────

import type { Socket as ClientSocket } from "socket.io-client";

export interface MockRelayOptions {
    // Future options
}

export interface MockRelaySession {
    sessionId: string;
    token: string;
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
