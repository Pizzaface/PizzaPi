// ============================================================================
// relay-cleanup.test.ts — Tests for the cleanup_child_session handler logic
//
// The relay handler is tightly coupled to Socket.IO and Redis at runtime,
// so we extract and test the core validation logic and dispatch decisions
// in isolation — the same approach used in extension.test.ts on the CLI side.
// ============================================================================

import { describe, it, expect, beforeEach } from "bun:test";

// ── Types mirroring relay session shape ──────────────────────────────────────

interface FakeSession {
    sessionId: string;
    userId: string | null;
    parentSessionId: string | null;
    runnerId: string | null;
}

// ── Core validation logic extracted from cleanup_child_session ───────────────
//
// This matches the guard sequence in relay.ts.  Tests verify the logic
// without requiring a live Socket.IO server or Redis connection.

type ValidationResult =
    | { ok: true; childSession: FakeSession }
    | { ok: false; error: string };

function validateCleanupChildSession(opts: {
    sessionId: string | undefined;
    tokenFromSocket: string;
    tokenFromData: string | undefined;
    childSessionId: string | undefined;
    getSession: (id: string) => FakeSession | null;
}): ValidationResult {
    const { sessionId, tokenFromSocket, tokenFromData, childSessionId, getSession } = opts;

    // 1. Session must exist on socket + token must match
    if (!sessionId || tokenFromData !== tokenFromSocket) {
        return { ok: false, error: "Invalid token" };
    }

    // 2. childSessionId must be provided
    if (!childSessionId) {
        return { ok: false, error: "cleanup_child_session requires childSessionId" };
    }

    // 3. Child session must exist (idempotent if already gone)
    const childSession = getSession(childSessionId);
    if (!childSession) {
        // Not an error — child already cleaned up.
        // Returning a special marker so callers can distinguish from error.
        return { ok: false, error: "CHILD_ALREADY_GONE" };
    }

    // 4. Sender must be the registered parent
    if (childSession.parentSessionId !== sessionId) {
        return { ok: false, error: "Sender is not the parent of the target session" };
    }

    // 5. Both sessions must belong to the same user
    const parentSession = getSession(sessionId);
    if (!parentSession?.userId || parentSession.userId !== childSession.userId) {
        return { ok: false, error: "Target session belongs to a different user" };
    }

    return { ok: true, childSession };
}

// ── Dispatch decisions after successful validation ────────────────────────────
//
// After validation passes, the handler:
//   a) emits kill_session to the runner socket (if local and connected)
//   b) broadcasts exec end_session to the child's relay socket room
//   c) calls removeChildSession
//   d) does NOT call endSharedSession (left to the child's disconnect handler)

interface DispatchRecord {
    killSessionSent: boolean;
    execEndSessionSent: boolean;
    removeChildSessionCalled: boolean;
    endSharedSessionCalled: boolean;
}

function simulateCleanupDispatch(opts: {
    childSession: FakeSession;
    parentSessionId: string;
    childSessionId: string;
    getRunnerSocket: (runnerId: string) => { connected: boolean; emit: (event: string, data: unknown) => void } | undefined;
    emitToRelaySession: (sessionId: string, event: string, data: unknown) => void;
    removeChildSession: (parentId: string, childId: string) => void;
    endSharedSession: (sessionId: string, reason: string) => void;
}): DispatchRecord {
    const record: DispatchRecord = {
        killSessionSent: false,
        execEndSessionSent: false,
        removeChildSessionCalled: false,
        endSharedSessionCalled: false,
    };

    // 1. kill_session → runner (local only)
    if (opts.childSession.runnerId) {
        const runnerSocket = opts.getRunnerSocket(opts.childSession.runnerId);
        if (runnerSocket?.connected) {
            runnerSocket.emit("kill_session", { sessionId: opts.childSessionId });
            record.killSessionSent = true;
        }
    }

    // 2. exec end_session → relay socket (cluster-wide broadcast)
    opts.emitToRelaySession(opts.childSessionId, "exec", {
        id: `cleanup-${opts.childSessionId}-0`,
        command: "end_session",
    });
    record.execEndSessionSent = true;

    // 3. removeChildSession
    opts.removeChildSession(opts.parentSessionId, opts.childSessionId);
    record.removeChildSessionCalled = true;

    // 4. endSharedSession is intentionally NOT called here
    // (left to child's disconnect handler)
    record.endSharedSessionCalled = false;

    return record;
}

// ── Sessions fixture ──────────────────────────────────────────────────────────

const USER_A = "user-a";
const USER_B = "user-b";

function makeSessionStore(sessions: FakeSession[]): (id: string) => FakeSession | null {
    const map = new Map(sessions.map((s) => [s.sessionId, s]));
    return (id) => map.get(id) ?? null;
}

// ── Validation tests ──────────────────────────────────────────────────────────

describe("cleanup_child_session — validation", () => {
    const parentSession: FakeSession = {
        sessionId: "parent-1",
        userId: USER_A,
        parentSessionId: null,
        runnerId: "runner-1",
    };

    const childSession: FakeSession = {
        sessionId: "child-1",
        userId: USER_A,
        parentSessionId: "parent-1",
        runnerId: "runner-1",
    };

    const getSession = makeSessionStore([parentSession, childSession]);

    it("accepts a valid cleanup request", () => {
        const result = validateCleanupChildSession({
            sessionId: "parent-1",
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: "child-1",
            getSession,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.childSession.sessionId).toBe("child-1");
        }
    });

    it("rejects mismatched token", () => {
        const result = validateCleanupChildSession({
            sessionId: "parent-1",
            tokenFromSocket: "correct",
            tokenFromData: "wrong",
            childSessionId: "child-1",
            getSession,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe("Invalid token");
    });

    it("rejects when sessionId is undefined (unauthenticated socket)", () => {
        const result = validateCleanupChildSession({
            sessionId: undefined,
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: "child-1",
            getSession,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe("Invalid token");
    });

    it("rejects missing childSessionId", () => {
        const result = validateCleanupChildSession({
            sessionId: "parent-1",
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: undefined,
            getSession,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("childSessionId");
    });

    it("returns CHILD_ALREADY_GONE when child session is not in Redis", () => {
        const result = validateCleanupChildSession({
            sessionId: "parent-1",
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: "nonexistent-child",
            getSession,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe("CHILD_ALREADY_GONE");
    });

    it("rejects when sender is not the parent of the child", () => {
        const imposter: FakeSession = {
            sessionId: "imposter",
            userId: USER_A,
            parentSessionId: null,
            runnerId: "runner-2",
        };
        const storeWithImposter = makeSessionStore([parentSession, childSession, imposter]);

        const result = validateCleanupChildSession({
            sessionId: "imposter",
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: "child-1",
            getSession: storeWithImposter,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("not the parent");
    });

    it("rejects cross-user cleanup attempt", () => {
        const otherUserChild: FakeSession = {
            sessionId: "child-other-user",
            userId: USER_B,
            parentSessionId: "parent-1",
            runnerId: "runner-1",
        };
        const crossStore = makeSessionStore([parentSession, otherUserChild]);

        const result = validateCleanupChildSession({
            sessionId: "parent-1",
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: "child-other-user",
            getSession: crossStore,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("different user");
    });

    it("rejects when parent has no userId", () => {
        const parentNoUser: FakeSession = {
            sessionId: "parent-nouser",
            userId: null,
            parentSessionId: null,
            runnerId: "runner-1",
        };
        // Child must point to this parent so the parentId check passes
        const childOfNoUser: FakeSession = {
            ...childSession,
            parentSessionId: "parent-nouser",
        };
        const storeNoUser = makeSessionStore([parentNoUser, childOfNoUser]);

        const result = validateCleanupChildSession({
            sessionId: "parent-nouser",
            tokenFromSocket: "tok",
            tokenFromData: "tok",
            childSessionId: childOfNoUser.sessionId,
            getSession: storeNoUser,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("different user");
    });
});

// ── Dispatch tests ────────────────────────────────────────────────────────────

describe("cleanup_child_session — dispatch", () => {
    const CHILD_ID = "child-dispatch";
    const PARENT_ID = "parent-dispatch";

    const childSession: FakeSession = {
        sessionId: CHILD_ID,
        userId: "user-x",
        parentSessionId: PARENT_ID,
        runnerId: "runner-local",
    };

    it("emits kill_session when local runner socket is connected", () => {
        const emittedKills: string[] = [];
        const localSocket = {
            connected: true,
            emit(event: string, data: any) {
                if (event === "kill_session") emittedKills.push(data.sessionId);
            },
        };

        const record = simulateCleanupDispatch({
            childSession,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => localSocket,
            emitToRelaySession: () => {},
            removeChildSession: () => {},
            endSharedSession: () => {},
        });

        expect(record.killSessionSent).toBe(true);
        expect(emittedKills).toContain(CHILD_ID);
    });

    it("skips kill_session when runner socket is not local", () => {
        const record = simulateCleanupDispatch({
            childSession,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => undefined, // runner on another node
            emitToRelaySession: () => {},
            removeChildSession: () => {},
            endSharedSession: () => {},
        });

        expect(record.killSessionSent).toBe(false);
    });

    it("skips kill_session when runner socket is disconnected", () => {
        const record = simulateCleanupDispatch({
            childSession,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => ({ connected: false, emit: () => {} }),
            emitToRelaySession: () => {},
            removeChildSession: () => {},
            endSharedSession: () => {},
        });

        expect(record.killSessionSent).toBe(false);
    });

    it("always broadcasts exec end_session (cluster-wide)", () => {
        const broadcasts: Array<{ sessionId: string; event: string; command: string }> = [];

        simulateCleanupDispatch({
            childSession,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => undefined,
            emitToRelaySession: (sessionId, event, data: any) => {
                broadcasts.push({ sessionId, event, command: data.command });
            },
            removeChildSession: () => {},
            endSharedSession: () => {},
        });

        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].sessionId).toBe(CHILD_ID);
        expect(broadcasts[0].event).toBe("exec");
        expect(broadcasts[0].command).toBe("end_session");
    });

    it("calls removeChildSession with parent and child IDs", () => {
        const removed: Array<[string, string]> = [];

        simulateCleanupDispatch({
            childSession,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => undefined,
            emitToRelaySession: () => {},
            removeChildSession: (p, c) => removed.push([p, c]),
            endSharedSession: () => {},
        });

        expect(removed).toHaveLength(1);
        expect(removed[0]).toEqual([PARENT_ID, CHILD_ID]);
    });

    it("does NOT call endSharedSession (left to disconnect handler)", () => {
        const endCalls: string[] = [];

        const record = simulateCleanupDispatch({
            childSession,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => undefined,
            emitToRelaySession: () => {},
            removeChildSession: () => {},
            endSharedSession: (id) => endCalls.push(id),
        });

        expect(record.endSharedSessionCalled).toBe(false);
        expect(endCalls).toHaveLength(0);
    });

    it("skips kill_session when child has no runnerId", () => {
        const childNoRunner: FakeSession = {
            ...childSession,
            runnerId: null,
        };
        const emittedKills: string[] = [];
        const fakeSocket = {
            connected: true,
            emit(event: string, data: any) {
                if (event === "kill_session") emittedKills.push(data.sessionId);
            },
        };

        const record = simulateCleanupDispatch({
            childSession: childNoRunner,
            parentSessionId: PARENT_ID,
            childSessionId: CHILD_ID,
            getRunnerSocket: () => fakeSocket,
            emitToRelaySession: () => {},
            removeChildSession: () => {},
            endSharedSession: () => {},
        });

        expect(record.killSessionSent).toBe(false);
        expect(emittedKills).toHaveLength(0);
    });
});
