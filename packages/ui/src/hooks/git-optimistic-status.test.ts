import { describe, expect, test } from "bun:test";
import type { GitStatus } from "./useGitService";
import {
    applyOptimisticMutation,
    cloneStatusSnapshot,
    consumeRollbackSnapshot,
} from "./git-optimistic-status";

function makeStatus(changes: GitStatus["changes"]): GitStatus {
    return {
        branch: "feat/optimistic",
        changes,
        ahead: 0,
        behind: 0,
        hasUpstream: true,
        diffStaged: "",
    };
}

describe("applyOptimisticMutation", () => {
    test("optimistically stages selected paths", () => {
        const status = makeStatus([
            { status: " M", path: "src/a.ts" },
            { status: "??", path: "src/new.ts" },
            { status: "M ", path: "src/already-staged.ts" },
        ]);

        const next = applyOptimisticMutation(status, {
            type: "stage",
            paths: ["src/a.ts", "src/new.ts"],
        });

        expect(next?.changes).toEqual([
            { status: "M ", path: "src/a.ts" },
            { status: "A ", path: "src/new.ts" },
            { status: "M ", path: "src/already-staged.ts" },
        ]);
    });

    test("optimistically stageAll stages all unstaged changes", () => {
        const status = makeStatus([
            { status: " M", path: "src/a.ts" },
            { status: "MM", path: "src/b.ts" },
            { status: "??", path: "src/c.ts" },
            { status: "M ", path: "src/staged.ts" },
        ]);

        const next = applyOptimisticMutation(status, {
            type: "stage",
            all: true,
        });

        expect(next?.changes).toEqual([
            { status: "M ", path: "src/a.ts" },
            { status: "M ", path: "src/b.ts" },
            { status: "A ", path: "src/c.ts" },
            { status: "M ", path: "src/staged.ts" },
        ]);
    });

    test("optimistically unstages selected paths", () => {
        const status = makeStatus([
            { status: "M ", path: "src/a.ts" },
            { status: "A ", path: "src/new.ts" },
            { status: "MM", path: "src/both.ts" },
        ]);

        const next = applyOptimisticMutation(status, {
            type: "unstage",
            paths: ["src/a.ts", "src/new.ts", "src/both.ts"],
        });

        expect(next?.changes).toEqual([
            { status: " M", path: "src/a.ts" },
            { status: "??", path: "src/new.ts" },
            { status: " M", path: "src/both.ts" },
        ]);
    });

    test("optimistically unstageAll removes staged-only added+deleted files", () => {
        const status = makeStatus([
            { status: "AD", path: "src/temp.ts" },
            { status: "D ", path: "src/remove.ts" },
        ]);

        const next = applyOptimisticMutation(status, {
            type: "unstage",
            all: true,
        });

        expect(next?.changes).toEqual([
            { status: " D", path: "src/remove.ts" },
        ]);
    });
});

describe("consumeRollbackSnapshot", () => {
    test("returns previous snapshot and clears it on failure", () => {
        const previous = makeStatus([{ status: " M", path: "src/a.ts" }]);
        const pending = new Map<string, GitStatus | null>();
        pending.set("req-1", cloneStatusSnapshot(previous));

        const rollback = consumeRollbackSnapshot(pending, "req-1", false);

        expect(rollback).toEqual(previous);
        expect(pending.has("req-1")).toBe(false);
    });

    test("does not rollback on success and still clears snapshot", () => {
        const pending = new Map<string, GitStatus | null>();
        pending.set("req-1", makeStatus([{ status: " M", path: "src/a.ts" }]));

        const rollback = consumeRollbackSnapshot(pending, "req-1", true);

        expect(rollback).toBeUndefined();
        expect(pending.has("req-1")).toBe(false);
    });

    test("ignores unknown request ids", () => {
        const pending = new Map<string, GitStatus | null>();

        const rollback = consumeRollbackSnapshot(pending, "missing", false);

        expect(rollback).toBeUndefined();
        expect(pending.size).toBe(0);
    });
});
