// ============================================================================
// sio-state-children.test.ts — Tests for child session Redis helpers
//
// Tests the addChildSession/getChildSessions/removeChildSession functions
// and the parentSessionId field in parseSessionFromHash.
//
// We mock the Redis client at module level so no live Redis is needed.
// ============================================================================

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

// ── Minimal Redis mock ──────────────────────────────────────────────────────

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();
const ttlStore = new Map<string, number>();

const mockMulti = () => {
    const ops: Array<() => void> = [];
    return {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                for (const [k, v] of Object.entries(fields)) {
                    store.set(`${key}:${k}`, v);
                }
                // Also store as hash for hGetAll
                const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
                Object.assign(existing, fields);
                store.set(`__hash__:${key}`, JSON.stringify(existing));
            });
            return mockMulti();
        }),
        sAdd: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key) ?? new Set();
                for (const m of members.flat()) s.add(m);
                setStore.set(key, s);
            });
            return mockMulti();
        }),
        sRem: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key);
                if (s) for (const m of members.flat()) s.delete(m);
            });
            return mockMulti();
        }),
        expire: mock((key: string, ttl: number) => {
            ops.push(() => ttlStore.set(key, ttl));
            return mockMulti();
        }),
        del: mock((key: string) => {
            ops.push(() => store.delete(key));
            return mockMulti();
        }),
        exec: mock(async () => {
            for (const op of ops) op();
            return ops.map(() => "OK");
        }),
    };
};

const mockRedis = {
    isOpen: true,
    sAdd: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key) ?? new Set();
        for (const m of members.flat()) s.add(m);
        setStore.set(key, s);
    }),
    sMembers: mock(async (key: string) => {
        return Array.from(setStore.get(key) ?? []);
    }),
    sRem: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key);
        if (s) for (const m of members.flat()) s.delete(m);
    }),
    sIsMember: mock(async (key: string, member: string) => {
        return setStore.get(key)?.has(member) ?? false;
    }),
    expire: mock(async (key: string, ttl: number) => {
        ttlStore.set(key, ttl);
    }),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    // Simple string key store (used by markChildAsDelinked / isChildDelinked)
    set: mock(async (key: string, value: string, _opts?: unknown) => {
        store.set(key, value);
    }),
    get: mock(async (key: string) => store.get(key) ?? null),
    del: mock(async (key: string) => {
        store.delete(key);
        setStore.delete(key);
        ttlStore.delete(key);
    }),
    exists: mock(async (key: string) => (store.has(key) ? 1 : 0)),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    }),
    hGet: mock(async () => null),
    hSet: mock(async (key: string, field: string, value: string) => {
        const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
        existing[field] = value;
        store.set(`__hash__:${key}`, JSON.stringify(existing));
        store.set(`${key}:${field}`, value);
    }),
    incr: mock(async () => 1),
    eval: mock(async () => 0),
};

mock.module("redis", () => ({
    createClient: () => mockRedis,
}));

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => mock.restore());

const {
    initStateRedis,
    addChildSession,
    addChildSessionMembership,
    getChildSessions,
    removeChildSession,
    removeChildren,
    clearAllChildren,
    clearParentSessionId,
    isChildOfParent,
    refreshChildSessionsTTL,
    addPendingParentDelinkChildren,
    getPendingParentDelinkChildren,
    removePendingParentDelinkChild,
    isPendingParentDelinkChild,
    markChildAsDelinked,
    isChildDelinked,
    clearDelinkedMark,
} = await import("./sio-state.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("child session helpers (sio-state)", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        ttlStore.clear();
        await initStateRedis();
    });

    it("addChildSession adds a child to the parent's set", async () => {
        await addChildSession("parent-1", "child-1");
        const children = await getChildSessions("parent-1");
        expect(children).toContain("child-1");
    });

    it("addChildSession supports multiple children", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await addChildSession("parent-1", "child-3");
        const children = await getChildSessions("parent-1");
        expect(children.sort()).toEqual(["child-1", "child-2", "child-3"]);
    });

    it("getChildSessions returns empty array for parentless sessions", async () => {
        const children = await getChildSessions("nonexistent-parent");
        expect(children).toEqual([]);
    });

    it("removeChildSession removes a specific child", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await removeChildSession("parent-1", "child-1");
        const children = await getChildSessions("parent-1");
        expect(children).toEqual(["child-2"]);
    });

    it("removeChildSession is safe on nonexistent child", async () => {
        await addChildSession("parent-1", "child-1");
        await removeChildSession("parent-1", "nonexistent");
        const children = await getChildSessions("parent-1");
        expect(children).toEqual(["child-1"]);
    });

    it("addChildSession is idempotent (adding same child twice)", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-1");
        const children = await getChildSessions("parent-1");
        expect(children).toEqual(["child-1"]);
    });

    it("clearAllChildren removes all children and returns their IDs", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await addChildSession("parent-1", "child-3");

        const removed = await clearAllChildren("parent-1");
        expect(removed.sort()).toEqual(["child-1", "child-2", "child-3"]);

        // Children set should be empty now
        const remaining = await getChildSessions("parent-1");
        expect(remaining).toEqual([]);
    });

    it("clearAllChildren returns empty array for nonexistent parent", async () => {
        const removed = await clearAllChildren("nonexistent");
        expect(removed).toEqual([]);
    });

    it("clearAllChildren does not affect other parents", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-2", "child-2");

        await clearAllChildren("parent-1");

        const p1Children = await getChildSessions("parent-1");
        const p2Children = await getChildSessions("parent-2");
        expect(p1Children).toEqual([]);
        expect(p2Children).toContain("child-2");
    });

    it("clearParentSessionId clears the field in Redis", async () => {
        // clearParentSessionId calls hSet with empty string on the session key.
        // We verify the mock was called correctly.
        await clearParentSessionId("child-1");
        // The hSet mock stores the value; verify it was called
        expect(mockRedis.hSet).toHaveBeenCalled();
    });

    // ── isChildOfParent ────────────────────────────────────────────────────

    it("isChildOfParent returns true when child is in parent's set", async () => {
        await addChildSession("parent-1", "child-1");
        expect(await isChildOfParent("parent-1", "child-1")).toBe(true);
    });

    it("isChildOfParent returns false for non-member", async () => {
        await addChildSession("parent-1", "child-1");
        expect(await isChildOfParent("parent-1", "child-99")).toBe(false);
    });

    it("isChildOfParent returns false after clearAllChildren (delink_children)", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");

        // Simulate delink_children: clear the set
        await clearAllChildren("parent-1");

        expect(await isChildOfParent("parent-1", "child-1")).toBe(false);
        expect(await isChildOfParent("parent-1", "child-2")).toBe(false);
    });

    it("isChildOfParent returns false for nonexistent parent set", async () => {
        expect(await isChildOfParent("ghost-parent", "child-1")).toBe(false);
    });

    // ── isChildOfParent TTL-expiry fallback ────────────────────────────────

    it("isChildOfParent falls back to session hash when Redis set has expired (TTL fallback)", async () => {
        // Simulate TTL expiry: the children set is absent, but the child's
        // session hash still records parentSessionId pointing to this parent.
        // isChildOfParent must return true via the session-hash fallback.
        store.set(
            "pizzapi:sio:session:child-fallback",
            JSON.stringify({ sessionId: "child-fallback", parentSessionId: "parent-ttl" }),
        );
        store.set(
            "__hash__:pizzapi:sio:session:child-fallback",
            JSON.stringify({ sessionId: "child-fallback", parentSessionId: "parent-ttl" }),
        );

        // No children set entry for parent-ttl
        expect(setStore.has("pizzapi:sio:children:parent-ttl")).toBe(false);

        const result = await isChildOfParent("parent-ttl", "child-fallback");
        expect(result).toBe(true);
    });

    it("isChildOfParent re-hydrates the children set after TTL fallback", async () => {
        // After the fallback confirms the relationship, the child must be
        // re-added to the Redis set so subsequent checks are fast.
        store.set(
            "__hash__:pizzapi:sio:session:child-rehydrate",
            JSON.stringify({ sessionId: "child-rehydrate", parentSessionId: "parent-rehydrate" }),
        );

        await isChildOfParent("parent-rehydrate", "child-rehydrate");

        // Set should now contain the child
        expect(setStore.get("pizzapi:sio:children:parent-rehydrate")?.has("child-rehydrate")).toBe(true);
        // TTL should have been refreshed
        expect(ttlStore.get("pizzapi:sio:children:parent-rehydrate")).toBe(24 * 60 * 60);
    });

    it("isChildOfParent returns false via fallback when parentSessionId does not match", async () => {
        // The child's hash has a different parentSessionId (e.g. it was re-linked
        // to another parent). The fallback must not grant access.
        store.set(
            "__hash__:pizzapi:sio:session:child-other",
            JSON.stringify({ sessionId: "child-other", parentSessionId: "different-parent" }),
        );

        const result = await isChildOfParent("parent-original", "child-other");
        expect(result).toBe(false);
    });

    it("isChildOfParent returns false after explicit delink (clearAllChildren + clearParentSessionId)", async () => {
        // Seed the session hash with the parent link
        store.set(
            "__hash__:pizzapi:sio:session:child-delinked",
            JSON.stringify({ sessionId: "child-delinked", parentSessionId: "parent-delink" }),
        );
        await addChildSession("parent-delink", "child-delinked");

        // Explicit delink: remove from set and clear parentSessionId in hash
        await clearAllChildren("parent-delink");
        store.set(
            "__hash__:pizzapi:sio:session:child-delinked",
            JSON.stringify({ sessionId: "child-delinked", parentSessionId: "" }),
        );

        // Both guards reject: set is cleared AND parentSessionId is ""
        const result = await isChildOfParent("parent-delink", "child-delinked");
        expect(result).toBe(false);
    });

    it("isChildOfParent does not fall back to the session hash when a delink marker exists", async () => {
        // Simulate the post-/new window for a connected child:
        // - The parent cleared the membership set
        // - The child's session hash still carries parentSessionId
        // - A delink marker exists until the child reconnects / processes parent_delinked
        //
        // In this state, isChildOfParent must return false and must NOT re-hydrate the set.
        store.set(
            "__hash__:pizzapi:sio:session:child-pending-delink",
            JSON.stringify({ sessionId: "child-pending-delink", parentSessionId: "parent-pending" }),
        );
        await markChildAsDelinked("child-pending-delink", "parent-pending");

        const result = await isChildOfParent("parent-pending", "child-pending-delink");
        expect(result).toBe(false);
        expect(setStore.has("pizzapi:sio:children:parent-pending")).toBe(false);
    });

    it("isChildOfParent returns true after removeChildSession leaves sibling", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await removeChildSession("parent-1", "child-2");

        expect(await isChildOfParent("parent-1", "child-1")).toBe(true);
        expect(await isChildOfParent("parent-1", "child-2")).toBe(false);
    });

    it("refreshChildSessionsTTL refreshes the membership set TTL", async () => {
        await addChildSession("parent-1", "child-1");
        ttlStore.set("pizzapi:sio:children:parent-1", 1);

        await refreshChildSessionsTTL("parent-1");

        expect(ttlStore.get("pizzapi:sio:children:parent-1")).toBe(24 * 60 * 60);
    });

    it("tracks pending parent_delinked retries per parent", async () => {
        await addPendingParentDelinkChildren("parent-1", ["child-1", "child-2"]);
        expect((await getPendingParentDelinkChildren("parent-1")).sort()).toEqual(["child-1", "child-2"]);
        expect(ttlStore.get("pizzapi:sio:pending-delink-children:parent-1")).toBe(24 * 60 * 60);
    });

    it("removePendingParentDelinkChild removes only the acked child", async () => {
        await addPendingParentDelinkChildren("parent-1", ["child-1", "child-2"]);
        await removePendingParentDelinkChild("parent-1", "child-1");
        expect(await getPendingParentDelinkChildren("parent-1")).toEqual(["child-2"]);
    });

    // ── Delink markers ─────────────────────────────────────────────────────
    // These markers are written by delink_children to prevent offline children
    // from re-linking to the old parent on their next reconnect.

    it("isChildDelinked returns false when no marker exists", async () => {
        expect(await isChildDelinked("child-orphan")).toBe(false);
    });

    it("markChildAsDelinked sets the marker; isChildDelinked returns true", async () => {
        await markChildAsDelinked("child-1", "parent-1");
        expect(await isChildDelinked("child-1")).toBe(true);
    });

    it("clearDelinkedMark removes the marker", async () => {
        await markChildAsDelinked("child-1", "parent-1");
        await clearDelinkedMark("child-1");
        expect(await isChildDelinked("child-1")).toBe(false);
    });

    it("markers are per-child and do not affect siblings", async () => {
        await markChildAsDelinked("child-1", "parent-1");
        expect(await isChildDelinked("child-1")).toBe(true);
        expect(await isChildDelinked("child-2")).toBe(false);
    });

    it("markChildAsDelinked is idempotent", async () => {
        await markChildAsDelinked("child-1", "parent-1");
        await markChildAsDelinked("child-1", "parent-1");
        expect(await isChildDelinked("child-1")).toBe(true);
        await clearDelinkedMark("child-1");
        expect(await isChildDelinked("child-1")).toBe(false);
    });

    it("addChildSession clears a stale delink marker for the child", async () => {
        // Simulate: parent delinked child-1, then later spawns it again.
        // The new addChildSession should clear the delink marker so future
        // reconnects don't reject the new legitimate parent link.
        await markChildAsDelinked("child-1", "parent-1");
        expect(await isChildDelinked("child-1")).toBe(true);
        await addChildSession("parent-2", "child-1");
        expect(await isChildDelinked("child-1")).toBe(false);
    });

    it("addChildSession removes child from former parent's pending-delink set (Fix #2)", async () => {
        // Scenario: P1 ran /new while C was online but delivery failed.
        // C stays in pending-delink-children:P1.  C is later linked to P2.
        // addChildSession(P2, C) must scrub C from pending-delink-children:P1
        // so P1's next /new doesn't re-sever the P2→C link.
        await markChildAsDelinked("child-1", "parent-1");
        await addPendingParentDelinkChildren("parent-1", ["child-1"]);
        expect(await isPendingParentDelinkChild("parent-1", "child-1")).toBe(true);

        await addChildSession("parent-2", "child-1");

        expect(await isChildDelinked("child-1")).toBe(false);
        expect(await isPendingParentDelinkChild("parent-1", "child-1")).toBe(false);
    });

    it("addChildSession with old-format marker ('1') does not attempt pending-delink cleanup", async () => {
        // Legacy markers stored "1" as the value — no parent ID available.
        // addChildSession must still clear the marker but not try to sRem from
        // a set keyed by "1" (that would be a garbage key operation).
        store.set("pizzapi:sio:delinked:child-1", "1");
        expect(await isChildDelinked("child-1")).toBe(true);

        await addChildSession("parent-2", "child-1");

        expect(await isChildDelinked("child-1")).toBe(false);
        // No garbage set entry created
        expect(setStore.has("pizzapi:sio:pending-delink-children:1")).toBe(false);
    });

    // ── addChildSessionMembership (transient-offline path) ─────────────────

    it("addChildSessionMembership adds child to membership set", async () => {
        await addChildSessionMembership("parent-1", "child-1");
        expect(await isChildOfParent("parent-1", "child-1")).toBe(true);
    });

    it("addChildSessionMembership does NOT clear a delink marker (Fix #1)", async () => {
        // When the parent is transiently offline during the child's reconnect,
        // we still add the child to the membership set (so delink_children can
        // find it), but we must NOT clear the delink marker — it may have been
        // set by a previous /new and should still gate the child's next reconnect
        // when the parent is actually online.
        await markChildAsDelinked("child-1", "parent-1");
        expect(await isChildDelinked("child-1")).toBe(true);

        await addChildSessionMembership("parent-1", "child-1");

        expect(await isChildOfParent("parent-1", "child-1")).toBe(true);
        expect(await isChildDelinked("child-1")).toBe(true); // marker preserved
    });

    // ── removeChildren (targeted removal) ──────────────────────────────────

    it("removeChildren removes only the specified children", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await addChildSession("parent-1", "child-3");

        await removeChildren("parent-1", ["child-1", "child-3"]);

        const remaining = await getChildSessions("parent-1");
        expect(remaining).toEqual(["child-2"]);
    });

    it("removeChildren preserves children added after the snapshot", async () => {
        // Simulate the race: snapshot sees child-1 and child-2, but child-3
        // is added between the snapshot and the removal.
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");

        // Snapshot: ["child-1", "child-2"]
        const snapshot = await getChildSessions("parent-1");

        // New child added after snapshot (simulates race)
        await addChildSession("parent-1", "child-3");

        // Remove only the snapshotted children
        await removeChildren("parent-1", snapshot);

        const remaining = await getChildSessions("parent-1");
        expect(remaining).toEqual(["child-3"]);
    });

    it("removeChildren is a no-op for empty array", async () => {
        await addChildSession("parent-1", "child-1");
        await removeChildren("parent-1", []);
        const remaining = await getChildSessions("parent-1");
        expect(remaining).toEqual(["child-1"]);
    });

    it("removeChildren is safe with nonexistent children", async () => {
        await addChildSession("parent-1", "child-1");
        await removeChildren("parent-1", ["nonexistent"]);
        const remaining = await getChildSessions("parent-1");
        expect(remaining).toEqual(["child-1"]);
    });
});
