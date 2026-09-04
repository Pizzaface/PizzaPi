import { describe, test, expect } from "bun:test";
import { runnerHue, runnerDisplayName } from "./runner-scope";
import type { RunnerInfo } from "@pizzapi/protocol";

describe("runner-scope", () => {
    test("hue is stable per runner id", () => {
        expect(runnerHue("runner-1")).toBe(runnerHue("runner-1"));
    });

    test("hue is in range", () => {
        for (const id of ["a", "b", "runner-1", "runner-2", "x".repeat(64)]) {
            const hue = runnerHue(id);
            expect(hue).toBeGreaterThanOrEqual(0);
            expect(hue).toBeLessThan(360);
            expect(Number.isInteger(hue)).toBe(true);
        }
    });

    test("different runners usually get different hues", () => {
        const hues = new Set(["runner-1", "runner-2", "runner-3", "runner-4"].map(runnerHue));
        expect(hues.size).toBeGreaterThan(1);
    });

    test("display name prefers the runner's announced name", () => {
        const runners = [{ runnerId: "r1", name: "MacBook" } as RunnerInfo];
        expect(runnerDisplayName("r1", runners)).toBe("MacBook");
    });

    test("display name truncates a long unknown id", () => {
        expect(runnerDisplayName("1234567890abcdef", [])).toBe("12345678…");
        expect(runnerDisplayName("short-id", [])).toBe("short-id");
    });
});