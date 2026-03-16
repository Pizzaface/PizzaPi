import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { formatTokens, formatUsageStats, toFinitePositiveInt } from "./subagent.js";
import { _setGlobalConfigDir, loadConfig } from "../config.js";

/**
 * Tests for the subagent tool utility functions.
 *
 * Execution tests (spawning pi processes) are not included here because they
 * require `pi` to be installed and are better suited for integration testing.
 * These tests cover the pure logic: formatting, validation, and type exports.
 */

describe("formatTokens", () => {
    test("formats small numbers as-is", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(42)).toBe("42");
        expect(formatTokens(999)).toBe("999");
    });

    test("formats thousands with one decimal", () => {
        expect(formatTokens(1000)).toBe("1.0k");
        expect(formatTokens(1500)).toBe("1.5k");
        expect(formatTokens(2345)).toBe("2.3k");
        expect(formatTokens(9999)).toBe("10.0k");
    });

    test("formats tens of thousands as rounded k", () => {
        expect(formatTokens(10000)).toBe("10k");
        expect(formatTokens(50000)).toBe("50k");
        expect(formatTokens(999999)).toBe("1000k");
    });

    test("formats millions with one decimal", () => {
        expect(formatTokens(1000000)).toBe("1.0M");
        expect(formatTokens(1500000)).toBe("1.5M");
        expect(formatTokens(10000000)).toBe("10.0M");
    });
});

describe("formatUsageStats", () => {
    test("returns empty string for zero usage", () => {
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        expect(formatUsageStats(usage)).toBe("");
    });

    test("includes input/output tokens", () => {
        const usage = { input: 2100, output: 850, cacheRead: 0, cacheWrite: 0, cost: 0 };
        const result = formatUsageStats(usage);
        expect(result).toContain("↑2.1k");
        expect(result).toContain("↓850");
    });

    test("includes cache stats when present", () => {
        const usage = { input: 1000, output: 500, cacheRead: 3000, cacheWrite: 1000, cost: 0 };
        const result = formatUsageStats(usage);
        expect(result).toContain("R3.0k");
        expect(result).toContain("W1.0k");
    });

    test("includes cost", () => {
        const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.0042 };
        const result = formatUsageStats(usage);
        expect(result).toContain("$0.0042");
    });

    test("includes turns when present", () => {
        const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 };
        const result = formatUsageStats(usage);
        expect(result).toContain("3 turns");
    });

    test("singular turn for 1", () => {
        const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
        const result = formatUsageStats(usage);
        expect(result).toContain("1 turn");
        expect(result).not.toContain("turns");
    });

    test("includes context tokens when present", () => {
        const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50000 };
        const result = formatUsageStats(usage);
        expect(result).toContain("ctx:50k");
    });

    test("includes model when provided", () => {
        const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.005 };
        const result = formatUsageStats(usage, "claude-haiku-3");
        expect(result).toContain("claude-haiku-3");
    });

    test("full usage stats line", () => {
        const usage = {
            input: 2100,
            output: 850,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.0042,
            turns: 3,
        };
        const result = formatUsageStats(usage, "claude-haiku-3");
        expect(result).toBe("3 turns ↑2.1k ↓850 $0.0042 claude-haiku-3");
    });
});

describe("SubagentDetails type exports", () => {
    test("SingleResult interface shape", () => {
        // Verify the interface is importable and usable
        const result: import("./subagent.js").SingleResult = {
            agent: "test",
            agentSource: "user",
            task: "test task",
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        };
        expect(result.agent).toBe("test");
        expect(result.agentSource).toBe("user");
    });

    test("SubagentDetails interface shape", () => {
        const details: import("./subagent.js").SubagentDetails = {
            mode: "single",
            agentScope: "user",
            projectAgentsDir: null,
            results: [],
        };
        expect(details.mode).toBe("single");
        expect(details.results).toEqual([]);
    });

    test("UsageStats interface shape", () => {
        const usage: import("./subagent.js").UsageStats = {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.001,
            contextTokens: 150,
            turns: 1,
        };
        expect(usage.input).toBe(100);
        expect(usage.turns).toBe(1);
    });
});

describe("toFinitePositiveInt", () => {
    test("returns the value for valid positive integers", () => {
        expect(toFinitePositiveInt(4, 99)).toBe(4);
        expect(toFinitePositiveInt(1, 99)).toBe(1);
        expect(toFinitePositiveInt(100, 99)).toBe(100);
    });

    test("floors floating point values", () => {
        expect(toFinitePositiveInt(4.7, 99)).toBe(4);
        expect(toFinitePositiveInt(1.1, 99)).toBe(1);
    });

    test("coerces numeric strings", () => {
        expect(toFinitePositiveInt("8", 99)).toBe(8);
        expect(toFinitePositiveInt("3.9", 99)).toBe(3);
    });

    test("returns fallback for non-numeric strings", () => {
        expect(toFinitePositiveInt("fast", 99)).toBe(99);
        expect(toFinitePositiveInt("", 99)).toBe(99);
    });

    test("returns fallback for zero, negative, Infinity, NaN", () => {
        expect(toFinitePositiveInt(0, 99)).toBe(99);
        expect(toFinitePositiveInt(-1, 99)).toBe(99);
        expect(toFinitePositiveInt(Infinity, 99)).toBe(99);
        expect(toFinitePositiveInt(-Infinity, 99)).toBe(99);
        expect(toFinitePositiveInt(NaN, 99)).toBe(99);
    });

    test("returns fallback for objects, arrays, null, undefined", () => {
        expect(toFinitePositiveInt({}, 99)).toBe(99);
        expect(toFinitePositiveInt([], 99)).toBe(99);
        expect(toFinitePositiveInt(null, 99)).toBe(99);
        expect(toFinitePositiveInt(undefined, 99)).toBe(99);
    });
});

describe("subagent config", () => {
    test("loadConfig reads subagent settings", () => {
        const tmp = mkdtempSync(join(tmpdir(), "subagent-config-"));
        _setGlobalConfigDir(tmp);
        writeFileSync(
            join(tmp, "config.json"),
            JSON.stringify({
                subagent: { maxParallelTasks: 16, maxConcurrency: 8 },
            }),
        );
        const config = loadConfig(tmp);
        expect(config.subagent?.maxParallelTasks).toBe(16);
        expect(config.subagent?.maxConcurrency).toBe(8);
        _setGlobalConfigDir(null);
    });

    test("loadConfig falls back to defaults for non-numeric subagent values", () => {
        const tmp = mkdtempSync(join(tmpdir(), "subagent-config-"));
        _setGlobalConfigDir(tmp);
        writeFileSync(
            join(tmp, "config.json"),
            JSON.stringify({
                subagent: { maxParallelTasks: "fast", maxConcurrency: {} },
            }),
        );
        const config = loadConfig(tmp);
        // toFinitePositiveInt should reject these at consumption time
        expect(toFinitePositiveInt(config.subagent?.maxParallelTasks, 8)).toBe(8);
        expect(toFinitePositiveInt(config.subagent?.maxConcurrency, 4)).toBe(4);
        _setGlobalConfigDir(null);
    });

    test("loadConfig returns defaults when subagent is not set", () => {
        const tmp = mkdtempSync(join(tmpdir(), "subagent-config-"));
        _setGlobalConfigDir(tmp);
        writeFileSync(join(tmp, "config.json"), JSON.stringify({}));
        const config = loadConfig(tmp);
        expect(config.subagent).toBeUndefined();
        _setGlobalConfigDir(null);
    });
});
