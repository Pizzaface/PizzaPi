import { describe, it, expect } from "bun:test";
import type { RunnerInfo } from "@pizzapi/protocol";
import { upsert } from "./runnerHelpers.js";
import type { UseRunnersFeedOptions } from "./useRunnersFeed.js";

function makeRunner(overrides: Partial<RunnerInfo> = {}): RunnerInfo {
    return {
        runnerId: "r1",
        name: "runner",
        roots: [],
        sessionCount: 0,
        skills: [],
        agents: [],
        plugins: [],
        hooks: [],
        version: null,
        platform: null,
        ...overrides,
    };
}

describe("useRunnersFeed state helpers", () => {
    describe("upsert (runner_added / runner_updated)", () => {
        it("appends a new runner", () => {
            const r = makeRunner({ runnerId: "r1" });
            const result = upsert([], r);
            expect(result).toHaveLength(1);
            expect(result[0].runnerId).toBe("r1");
        });

        it("replaces existing runner by runnerId", () => {
            const old = makeRunner({ runnerId: "r1", name: "old" });
            const updated = makeRunner({ runnerId: "r1", name: "new" });
            const result = upsert([old], updated);
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe("new");
        });

        it("does not affect other runners", () => {
            const r1 = makeRunner({ runnerId: "r1" });
            const r2 = makeRunner({ runnerId: "r2", name: "other" });
            const updated = makeRunner({ runnerId: "r1", name: "updated" });
            const result = upsert([r1, r2], updated);
            expect(result).toHaveLength(2);
            expect(result.find(r => r.runnerId === "r2")?.name).toBe("other");
        });
    });

    describe("remove (runner_removed)", () => {
        it("removes runner by runnerId", () => {
            const runners = [makeRunner({ runnerId: "r1" }), makeRunner({ runnerId: "r2" })];
            const result = runners.filter(r => r.runnerId !== "r1");
            expect(result).toHaveLength(1);
            expect(result[0].runnerId).toBe("r2");
        });

        it("is a no-op when runnerId not found", () => {
            const runners = [makeRunner({ runnerId: "r1" })];
            const result = runners.filter(r => r.runnerId !== "ghost");
            expect(result).toHaveLength(1);
        });
    });
});

describe("UseRunnersFeedOptions type contract", () => {
    // Pure type-level tests: verify the options shape is accepted correctly.
    // These compile-time assertions catch regressions in the option interface.

    it("accepts empty options (all defaults)", () => {
        const opts: UseRunnersFeedOptions = {};
        expect(opts).toBeDefined();
    });

    it("accepts enabled=false to disable feed", () => {
        const opts: UseRunnersFeedOptions = { enabled: false };
        expect(opts.enabled).toBe(false);
    });

    it("accepts enabled=true with a userId", () => {
        const opts: UseRunnersFeedOptions = { enabled: true, userId: "user-abc" };
        expect(opts.userId).toBe("user-abc");
    });

    it("accepts userId=null (logged out)", () => {
        const opts: UseRunnersFeedOptions = { enabled: false, userId: null };
        expect(opts.userId).toBeNull();
    });

    it("accepts userId=undefined (pending auth)", () => {
        const opts: UseRunnersFeedOptions = { enabled: false, userId: undefined };
        expect(opts.userId).toBeUndefined();
    });
});
