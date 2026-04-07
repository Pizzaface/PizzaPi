import { describe, expect, mock, test } from "bun:test";
import { countLinkedChildrenForParent } from "./child-lifecycle.js";

describe("countLinkedChildrenForParent", () => {
    test("returns the linked child count for a parent session", async () => {
        const getChildSessions = mock(async (_parentSessionId: string) => ["child-1", "child-2", "child-3"]);

        await expect(countLinkedChildrenForParent("parent-1", { getChildSessions })).resolves.toBe(3);
        expect(getChildSessions).toHaveBeenCalledWith("parent-1");
    });
});
