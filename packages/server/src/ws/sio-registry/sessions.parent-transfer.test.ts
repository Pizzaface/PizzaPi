// ============================================================================
// sessions.parent-transfer.test.ts — Regression tests for child-session
// ownership: atomic parent transfer on relink, and membership removal on
// confirmed terminal end (endSharedSession confirmedTerminal).
// Harness mirrors sessions.parent-miss-delink.test.ts.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    recordRelaySessionStateSerialized: async () => {},
    touchRelaySession: async () => {},
}));

mock.module("../../sessions/trigger-subscription-store.js", () => ({
    clearSessionSubscriptions: async () => {},
}));

mock.module("../../sessions/trigger-store.js", () => ({
    pushTriggerHistory: async () => {},
}));

const childrenKey = (p: string) => `children:${p}`;
const pendingDelinkKey = (p: string) => `pending-delink:${p}`;
const sessionHashKey = (s: string) => `session:${s}`;

mock.module("../sio-state/index.js", () => ({
    acquireSessionOwnershipLock: async () => {},
    releaseSessionOwnershipLock: async () => {},
    deleteSessionIfOwner: async () => true,
    initStateRedis: async () => {},
    setSession: async (sessionId: string, data: Record<string, unknown>) => {
        store.set(sessionHashKey(sessionId), JSON.stringify(data));
    },
    getSession: async (sessionId: string) => {
        const raw = store.get(sessionHashKey(sessionId));
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    getSessionSummary: async (sessionId: string) => {
        const raw = store.get(sessionHashKey(sessionId));
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    getSessionField: async () => null,
    updateSessionFields: async () => {},
    deleteSession: async (sessionId: string) => {
        store.delete(sessionHashKey(sessionId));
    },
    getAllSessionSummaries: async () => [],
    refreshSessionTTL: async () => {},
    incrementSeq: async () => 1,
    getSeq: async () => 0,
    setPendingRunnerLink: async () => {},
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: async () => {},
    getRunnerAssociation: async () => null,
    setRunnerAssociation: async () => {},
    refreshRunnerAssociationTTL: async () => {},
    scanExpiredSessions: async () => [],
    addChildSession: async (parentSessionId: string, childSessionId: string) => {
        const s = setStore.get(childrenKey(parentSessionId)) ?? new Set();
        s.add(childSessionId);
        setStore.set(childrenKey(parentSessionId), s);
    },
    addChildSessionMembership: async (parentSessionId: string, childSessionId: string) => {
        const s = setStore.get(childrenKey(parentSessionId)) ?? new Set();
        s.add(childSessionId);
        setStore.set(childrenKey(parentSessionId), s);
    },
    removeChildSession: async (parentSessionId: string, childSessionId: string) => {
        setStore.get(childrenKey(parentSessionId))?.delete(childSessionId);
    },
    isChildDelinked: async (childSessionId: string) => store.has(`delinked:${childSessionId}`),
    clearParentSessionId: async () => {},
    refreshChildSessionsTTL: async () => {},
    removePendingParentDelinkChild: async (parentSessionId: string, childSessionId: string) => {
        setStore.get(pendingDelinkKey(parentSessionId))?.delete(childSessionId);
    },
    markChildAsDelinked: async (childSessionId: string) => {
        store.set(`delinked:${childSessionId}`, "1");
    },
    getRunner: async () => null,
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));

afterAll(() => mock.restore());

const { registerTuiSession, endSharedSession } = await import("./sessions.js");
const { initSioRegistry } = await import("./context.js");

// Minimal fake Socket.IO server — enough for endSharedSession's viewer teardown.
const fakeNamespace = {
    to: () => ({ emit: () => {} }),
    local: { to: () => ({ emit: () => {} }) },
    in: () => ({ disconnectSockets: () => {} }),
    emit: () => {},
};
initSioRegistry({ of: () => fakeNamespace } as never);

function fakeSocket() {
    return { join: async () => {}, data: {} } as never;
}

async function seedSession(sessionId: string, extra: Record<string, unknown> = {}) {
    store.set(
        sessionHashKey(sessionId),
        JSON.stringify({
            sessionId,
            userId: "u1",
            token: "t",
            startedAt: new Date().toISOString(),
            parentSessionId: null,
            linkedParentId: null,
            ...extra,
        }),
    );
}

describe("atomic parent transfer on relink", () => {
    beforeEach(() => {
        store.clear();
        setStore.clear();
    });

    it("removes the child from the old parent's membership and pending-delink sets when relinked to a new parent", async () => {
        await seedSession("parent-1");
        await seedSession("parent-2");

        // Link child to parent-1
        await registerTuiSession(fakeSocket(), "", {
            sessionId: "child-1",
            userId: "u1",
            isEphemeral: false,
            parentSessionId: "parent-1",
        });
        expect(setStore.get(childrenKey("parent-1"))?.has("child-1")).toBe(true);

        // Simulate a stale pending-delink entry for the old parent too.
        setStore.set(pendingDelinkKey("parent-1"), new Set(["child-1"]));

        // Reconnect with a NEW parent
        await registerTuiSession(fakeSocket(), "", {
            sessionId: "child-1",
            userId: "u1",
            isEphemeral: false,
            parentSessionId: "parent-2",
        });

        expect(setStore.get(childrenKey("parent-2"))?.has("child-1")).toBe(true);
        // Old parent must no longer own the child — no dual ownership.
        expect(setStore.get(childrenKey("parent-1"))?.has("child-1")).toBe(false);
        expect(setStore.get(pendingDelinkKey("parent-1"))?.has("child-1")).toBe(false);
    });

    it("keeps membership intact when reconnecting with the same parent", async () => {
        await seedSession("parent-1");
        await registerTuiSession(fakeSocket(), "", {
            sessionId: "child-2",
            userId: "u1",
            isEphemeral: false,
            parentSessionId: "parent-1",
        });
        await registerTuiSession(fakeSocket(), "", {
            sessionId: "child-2",
            userId: "u1",
            isEphemeral: false,
            parentSessionId: "parent-1",
        });
        expect(setStore.get(childrenKey("parent-1"))?.has("child-2")).toBe(true);
    });
});

describe("endSharedSession confirmedTerminal membership removal", () => {
    beforeEach(() => {
        store.clear();
        setStore.clear();
    });

    it("removes the child from its parent's set on confirmed terminal end", async () => {
        await seedSession("child-x", { parentSessionId: "parent-1" });
        setStore.set(childrenKey("parent-1"), new Set(["child-x"]));

        await endSharedSession("child-x", "Session ended", { confirmedTerminal: true });

        expect(setStore.get(childrenKey("parent-1"))?.has("child-x")).toBe(false);
        expect(store.has(sessionHashKey("child-x"))).toBe(false);
    });

    it("uses linkedParentId when parentSessionId was cleared (parent-offline reconnect)", async () => {
        await seedSession("child-y", { parentSessionId: null, linkedParentId: "parent-1" });
        setStore.set(childrenKey("parent-1"), new Set(["child-y"]));

        await endSharedSession("child-y", "Session ended", { confirmedTerminal: true });

        expect(setStore.get(childrenKey("parent-1"))?.has("child-y")).toBe(false);
    });

    it("preserves membership on transient disconnect (not confirmed terminal)", async () => {
        await seedSession("child-z", { parentSessionId: "parent-1" });
        setStore.set(childrenKey("parent-1"), new Set(["child-z"]));

        await endSharedSession("child-z", "Session ended");

        // Membership must survive so delink_children can still find the child.
        expect(setStore.get(childrenKey("parent-1"))?.has("child-z")).toBe(true);
    });
});
