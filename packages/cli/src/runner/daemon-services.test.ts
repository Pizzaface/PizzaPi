import { describe, test, expect } from "bun:test";
import { resolveDisabledRunnerServices } from "./daemon.js";

describe("resolveDisabledRunnerServices", () => {
    test("returns empty set by default", () => {
        expect(resolveDisabledRunnerServices({})).toEqual(new Set());
    });

    test("collects IDs from config array", () => {
        expect(resolveDisabledRunnerServices({ disabledRunnerServices: ["git", "time"] })).toEqual(
            new Set(["git", "time"]),
        );
    });

    test("parses comma-separated env var", () => {
        expect(resolveDisabledRunnerServices({}, "git, time ,terminal")).toEqual(
            new Set(["git", "time", "terminal"]),
        );
    });

    test("merges env var and config", () => {
        expect(resolveDisabledRunnerServices({ disabledRunnerServices: ["git"] }, "time")).toEqual(
            new Set(["git", "time"]),
        );
    });

    test("ignores non-string config entries and empty env tokens", () => {
        expect(
            resolveDisabledRunnerServices(
                { disabledRunnerServices: ["git", 123 as unknown as string, null as unknown as string] },
                ",,time,",
            ),
        ).toEqual(new Set(["git", "time"]));
    });
});
