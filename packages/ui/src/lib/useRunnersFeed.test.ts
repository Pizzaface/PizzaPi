import { describe, it, expect } from "bun:test";
import type { RunnerInfo } from "@pizzapi/protocol";
import { upsert } from "./runnerHelpers.js";

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
