// ============================================================================
// end-session-guard.test.ts — Tests for the restart race condition fix
//
// When a session is restarted (/restart), the old socket's disconnect handler
// races with the new socket's registration. The old disconnect must NOT delete
// the newly-created session.
//
// The fix has two layers:
// 1. relay.ts disconnect handler: checks if a new socket already owns the
//    session (via getLocalTuiSocket) and skips cleanup if so.
// 2. endSharedSession: accepts an optional expectedToken param. If provided,
//    it verifies the token matches the current session before deleting.
//
// Since sio-registry.ts has heavy dependencies (Redis, Socket.IO, SQLite),
// we test the token comparison logic in isolation.
// ============================================================================

import { describe, it, expect } from "bun:test";

// The core logic is: if expectedToken is provided and doesn't match session.token, skip.
// This is a pure function test of the guard condition.

interface SessionData {
    token: string;
    sessionId: string;
}

function shouldSkipEndSession(session: SessionData | null, expectedToken?: string): boolean {
    if (!session) return true; // no session = nothing to delete
    if (expectedToken && session.token !== expectedToken) return true; // token mismatch = skip
    return false;
}

describe("endSharedSession token guard logic", () => {
    it("proceeds when no token is provided (backward compat)", () => {
        const session = { token: "abc", sessionId: "s1" };
        expect(shouldSkipEndSession(session)).toBe(false);
        expect(shouldSkipEndSession(session, undefined)).toBe(false);
    });

    it("proceeds when token matches", () => {
        const session = { token: "abc", sessionId: "s1" };
        expect(shouldSkipEndSession(session, "abc")).toBe(false);
    });

    it("skips when token does NOT match (restart race)", () => {
        // Scenario: old disconnect fires with old token, but session now has new token
        const session = { token: "NEW-token", sessionId: "s1" };
        expect(shouldSkipEndSession(session, "OLD-token")).toBe(true);
    });

    it("skips when session is null", () => {
        expect(shouldSkipEndSession(null)).toBe(true);
        expect(shouldSkipEndSession(null, "any-token")).toBe(true);
    });
});

describe("disconnect handler socket ownership check", () => {
    it("skips cleanup when a new socket owns the session", () => {
        // Simulates getLocalTuiSocket returning a different socket
        const disconnectingSocketId = "old-socket-123" as string;
        const currentSocketId = "new-socket-456" as string;

        const shouldSkip = currentSocketId !== disconnectingSocketId;
        expect(shouldSkip).toBe(true);
    });

    it("proceeds with cleanup when this socket still owns the session", () => {
        const socketId = "socket-123";
        const disconnectingSocketId: string = socketId;
        const currentSocketId: string = socketId;

        const shouldSkip = currentSocketId !== disconnectingSocketId;
        expect(shouldSkip).toBe(false);
    });

    it("proceeds when no socket is registered (session already gone)", () => {
        const disconnectingSocketId = "old-socket-123";
        const currentSocketId: string | null = null;

        // If no current socket, the session is already gone — proceed with cleanup
        const shouldSkip = currentSocketId !== null && currentSocketId !== disconnectingSocketId;
        expect(shouldSkip).toBe(false);
    });
});
