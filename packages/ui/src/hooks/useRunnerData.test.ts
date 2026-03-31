import { describe, expect, it } from "bun:test";
import type { RunnerInfo } from "@pizzapi/protocol";
import { findRunnerById } from "./useRunnerData.js";

function makeRunner(overrides: Partial<RunnerInfo> = {}): RunnerInfo {
    return {
        runnerId: "runner-1",
        name: "Runner One",
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

describe("findRunnerById", () => {
    it("returns the matching runner", () => {
        const runners = [makeRunner({ runnerId: "runner-a" }), makeRunner({ runnerId: "runner-b" })];

        expect(findRunnerById(runners, "runner-b")?.runnerId).toBe("runner-b");
    });

    it("returns null when the runner is missing", () => {
        const runners = [makeRunner({ runnerId: "runner-a" })];

        expect(findRunnerById(runners, "ghost")).toBeNull();
    });

    it("returns null when runnerId is nullish", () => {
        const runners = [makeRunner()];

        expect(findRunnerById(runners, null)).toBeNull();
        expect(findRunnerById(runners, undefined)).toBeNull();
    });
});
