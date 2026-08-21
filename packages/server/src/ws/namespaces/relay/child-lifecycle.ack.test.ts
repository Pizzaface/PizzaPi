// ============================================================================
// child-lifecycle.ack.test.ts — Regression tests for cleanup_child_session
// ack ordering (ack after observed termination, pending status on timeout)
// and stale-entry removal for already-gone children.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocked collaborators ─────────────────────────────────────────────────────

const sessions = new Map<string, Record<string, unknown>>();
const childSets = new Map<string, Set<string>>();
const emittedToRelay: Array<{ sessionId: string; event: string; payload: unknown }> = [];
const endedSessions: Array<{ sessionId: string; reason: string; opts?: unknown }> = [];
let relayPresence: { kind: "count"; count: number } | { kind: "unknown" } = { kind: "count", count: 0 };

mock.module("../../sio-registry.js", () => ({
    getSharedSessionSummary: async (id: string) => sessions.get(id) ?? null,
    emitToRelaySession: (sessionId: string, event: string, payload: unknown) => {
        emittedToRelay.push({ sessionId, event, payload });
    },
    emitToRelaySessionAwaitingAck: async () => ({ hadListeners: false, acked: false }),
    emitToRunner: () => {},
    countSocketsInRoomCluster: async () => relayPresence,
    endSharedSession: async (sessionId: string, reason: string, opts?: unknown) => {
        endedSessions.push({ sessionId, reason, opts });
        sessions.delete(sessionId);
    },
}));

mock.module("../../sio-state/index.js", () => ({
    removeChildSession: async (parentId: string, childId: string) => {
        childSets.get(parentId)?.delete(childId);
    },
    removeChildren: async () => {},
    addPendingParentDelinkChildren: async () => {},
    getChildSessions: async (parentId: string) => Array.from(childSets.get(parentId) ?? []),
    getPendingParentDelinkChildren: async () => [],
    removePendingParentDelinkChild: async () => {},
    getSessionSummary: async (id: string) => sessions.get(id) ?? null,
    markChildAsDelinked: async () => {},
    isChildDelinked: async () => false,
    isChildOfParent: async (parentId: string, childId: string) =>
        childSets.get(parentId)?.has(childId) ?? false,
    clearParentSessionId: async () => {},
}));

afterAll(() => mock.restore());

const { registerChildLifecycleHandlers, waitForChildTermination, childTerminationWait } =
    await import("./child-lifecycle.js");

// ── Fake socket / io ─────────────────────────────────────────────────────────

function makeSocket(sessionId: string, token = "tok") {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    return {
        handlers,
        socket: {
            data: { sessionId, token },
            on(event: string, cb: (...args: unknown[]) => unknown) {
                handlers.set(event, cb);
            },
            emit: () => {},
        } as never,
        async fire(event: string, data: unknown): Promise<unknown> {
            let ackResult: unknown;
            await handlers.get(event)!(data, (r: unknown) => {
                ackResult = r;
            });
            return ackResult;
        },
    };
}

/** Fake io; cluster presence is controlled independently of local rooms. */
function makeIo() {
    return { of: () => ({}) } as never;
}

function seed(parentId: string, childId: string, extra: Record<string, unknown> = {}) {
    sessions.set(parentId, { sessionId: parentId, userId: "u1", parentSessionId: null });
    sessions.set(childId, { sessionId: childId, userId: "u1", parentSessionId: parentId, runnerId: null, ...extra });
    childSets.set(parentId, new Set([childId]));
}

describe("cleanup_child_session ack ordering", () => {
    beforeEach(() => {
        sessions.clear();
        childSets.clear();
        emittedToRelay.length = 0;
        endedSessions.length = 0;
        childTerminationWait.timeoutMs = 300;
        childTerminationWait.pollMs = 20;
        relayPresence = { kind: "count", count: 0 };
    });

    it("acks plain ok once child termination is observed", async () => {
        seed("parent", "child");
        relayPresence = { kind: "count", count: 1 };
        const { socket, fire } = makeSocket("parent");
        registerChildLifecycleHandlers(socket, makeIo());

        // Simulate the child terminating shortly after the exec is sent.
        setTimeout(() => sessions.delete("child"), 50);

        const ack = (await fire("cleanup_child_session", { token: "tok", childSessionId: "child" })) as {
            ok: boolean;
            pending?: boolean;
        };
        expect(ack.ok).toBe(true);
        expect(ack.pending).toBeUndefined();
        // Termination exec was dispatched before the ack.
        expect(emittedToRelay.some((e) => e.sessionId === "child" && e.event === "exec")).toBe(true);
    });

    it("acks pending when the child does not terminate within the bounded wait", async () => {
        seed("parent", "child");
        relayPresence = { kind: "count", count: 1 };
        const { socket, fire } = makeSocket("parent");
        registerChildLifecycleHandlers(socket, makeIo());

        const ack = (await fire("cleanup_child_session", { token: "tok", childSessionId: "child" })) as {
            ok: boolean;
            pending?: boolean;
        };
        expect(ack.ok).toBe(true);
        expect(ack.pending).toBe(true);
    });

    it("ends the child directly (confirmedTerminal) when no relay recipient exists", async () => {
        seed("parent", "child");
        const { socket, fire } = makeSocket("parent");
        registerChildLifecycleHandlers(socket, makeIo());

        const ack = (await fire("cleanup_child_session", { token: "tok", childSessionId: "child" })) as {
            ok: boolean;
        };
        expect(ack.ok).toBe(true);
        expect(endedSessions).toEqual([
            { sessionId: "child", reason: "Parent acknowledged completion", opts: { confirmedTerminal: true } },
        ]);
    });

    it("keeps the child when cluster presence is unknown", async () => {
        seed("parent", "child");
        relayPresence = { kind: "unknown" };
        childTerminationWait.timeoutMs = 0;
        const { socket, fire } = makeSocket("parent");
        registerChildLifecycleHandlers(socket, makeIo());

        await fire("cleanup_child_session", { token: "tok", childSessionId: "child" });
        expect(endedSessions).toEqual([]);
    });

    it("removes the stale membership entry when the child is already gone", async () => {
        sessions.set("parent", { sessionId: "parent", userId: "u1", parentSessionId: null });
        childSets.set("parent", new Set(["ghost-child"]));
        const { socket, fire } = makeSocket("parent");
        registerChildLifecycleHandlers(socket, makeIo());

        const ack = (await fire("cleanup_child_session", { token: "tok", childSessionId: "ghost-child" })) as {
            ok: boolean;
        };
        expect(ack.ok).toBe(true);
        expect(childSets.get("parent")?.has("ghost-child")).toBe(false);
    });
});

describe("waitForChildTermination", () => {
    beforeEach(() => {
        childTerminationWait.timeoutMs = 200;
        childTerminationWait.pollMs = 20;
    });

    it("returns true immediately when the session is already gone", async () => {
        expect(await waitForChildTermination("nope", { getSession: async () => null })).toBe(true);
    });

    it("returns false when the session outlives the wait", async () => {
        expect(
            await waitForChildTermination("stuck", { getSession: async () => ({ sessionId: "stuck" }) as never }),
        ).toBe(false);
    });
});
