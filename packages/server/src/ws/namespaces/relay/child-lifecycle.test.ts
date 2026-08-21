import { describe, expect, mock, test } from "bun:test";
import { countLinkedChildrenForParent, executeCleanupTeardown } from "./child-lifecycle.js";

describe("countLinkedChildrenForParent", () => {
    test("returns count of live, linked children", async () => {
        const getChildSessions = mock(async () => ["child-1", "child-2", "child-3"]);
        const getSession = mock(async (id: string) => {
            if (id === "child-1") return { parentSessionId: "parent-1" } as any;
            if (id === "child-2") return { parentSessionId: "parent-1" } as any;
            if (id === "child-3") return { parentSessionId: "parent-1" } as any;
            return null;
        });

        const count = await countLinkedChildrenForParent("parent-1", { getChildSessions, getSession });
        expect(count).toBe(3);
        expect(getChildSessions).toHaveBeenCalledWith("parent-1");
    });

    test("excludes children whose session hash is gone (ended)", async () => {
        const getChildSessions = mock(async () => ["child-live", "child-dead"]);
        const getSession = mock(async (id: string) => {
            if (id === "child-live") return { parentSessionId: "parent-1" } as any;
            return null; // child-dead has no session hash
        });

        const count = await countLinkedChildrenForParent("parent-1", { getChildSessions, getSession });
        expect(count).toBe(1);
    });

    test("excludes children that point at a different parent", async () => {
        const getChildSessions = mock(async () => ["child-mine", "child-stale"]);
        const getSession = mock(async (id: string) => {
            if (id === "child-mine") return { parentSessionId: "parent-1" } as any;
            if (id === "child-stale") return { parentSessionId: "other-parent" } as any;
            return null;
        });

        const count = await countLinkedChildrenForParent("parent-1", { getChildSessions, getSession });
        expect(count).toBe(1);
    });

    test("counts children linked via linkedParentId", async () => {
        const getChildSessions = mock(async () => ["child-1"]);
        const getSession = mock(async () => ({
            parentSessionId: null, // cleared during transient offline
            linkedParentId: "parent-1",
        }) as any);

        const count = await countLinkedChildrenForParent("parent-1", { getChildSessions, getSession });
        expect(count).toBe(1);
    });

    test("returns 0 when membership set is empty", async () => {
        const getChildSessions = mock(async () => [] as string[]);
        const getSession = mock(async () => null);

        const count = await countLinkedChildrenForParent("parent-1", { getChildSessions, getSession });
        expect(count).toBe(0);
        // getSession should not be called at all when there are no children
        expect(getSession).not.toHaveBeenCalled();
    });

    test("returns 0 when all children are stale (ended or re-linked)", async () => {
        const getChildSessions = mock(async () => ["child-dead", "child-relinked"]);
        const getSession = mock(async (id: string) => {
            if (id === "child-dead") return null;
            if (id === "child-relinked") return { parentSessionId: "different-parent" } as any;
            return null;
        });

        const count = await countLinkedChildrenForParent("parent-1", { getChildSessions, getSession });
        expect(count).toBe(0);
    });
});

describe("executeCleanupTeardown — fail-open gating", () => {
    function makeDeps(presenceResult: { kind: "count"; count: number } | { kind: "unknown" }) {
        return {
            countPresence: mock(async () => presenceResult),
            emitRunner: mock((_runnerId: string, _event: string, _data: unknown) => {}),
            emitRelay: mock((_sessionId: string, _event: string, _data: unknown) => {}),
            endSession: mock(async (_sessionId: string, _reason: string, _opts: unknown) => {}),
        };
    }

    test("unknown presence → skips teardown (fail-open)", async () => {
        const deps = makeDeps({ kind: "unknown" });
        const result = await executeCleanupTeardown("child-1", "runner-1", deps);
        expect(result).toBe("skipped");
        expect(deps.emitRunner).not.toHaveBeenCalled();
        expect(deps.emitRelay).not.toHaveBeenCalled();
        expect(deps.endSession).not.toHaveBeenCalled();
    });

    test("count === 0 → executes teardown (kill + end_session + endSharedSession)", async () => {
        const deps = makeDeps({ kind: "count", count: 0 });
        const result = await executeCleanupTeardown("child-2", "runner-2", deps);
        expect(result).toBe("torn-down");
        expect(deps.emitRunner).toHaveBeenCalledWith("runner-2", "kill_session", { sessionId: "child-2" });
        expect(deps.emitRelay).toHaveBeenCalledWith("child-2", "exec", expect.objectContaining({ command: "end_session" }));
        expect(deps.endSession).toHaveBeenCalledWith("child-2", "Parent acknowledged completion", { confirmedTerminal: true });
    });

    test("count > 0 → skips teardown (relay socket still present)", async () => {
        const deps = makeDeps({ kind: "count", count: 2 });
        const result = await executeCleanupTeardown("child-3", "runner-3", deps);
        expect(result).toBe("skipped");
        expect(deps.emitRunner).not.toHaveBeenCalled();
        expect(deps.emitRelay).not.toHaveBeenCalled();
        expect(deps.endSession).not.toHaveBeenCalled();
    });

    test("count === 0 with no runnerId → skips kill_session but still ends session", async () => {
        const deps = makeDeps({ kind: "count", count: 0 });
        const result = await executeCleanupTeardown("child-4", undefined, deps);
        expect(result).toBe("torn-down");
        expect(deps.emitRunner).not.toHaveBeenCalled();
        expect(deps.emitRelay).toHaveBeenCalled();
        expect(deps.endSession).toHaveBeenCalled();
    });
});
