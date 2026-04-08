import { describe, expect, mock, test } from "bun:test";
import { countLinkedChildrenForParent } from "./child-lifecycle.js";

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
