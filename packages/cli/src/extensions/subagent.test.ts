import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    formatTokens,
    formatUsageStats,
    toFinitePositiveInt,
    PARALLEL_SPILL_THRESHOLD,
    sanitizeAgentFileSegment,
    shouldSpillParallelOutput,
    summarizeResultForStreaming,
    summarizeResultsForStreaming,
    parseModelString,
    selectLightweightModel,
} from "./subagent.js";
import { _setGlobalConfigDir, loadConfig, loadGlobalConfig } from "../config.js";

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

describe("streaming summary helpers", () => {
    test("summarizeResultForStreaming drops full transcript data while preserving preview fields", () => {
        const summary = summarizeResultForStreaming({
            agent: "researcher",
            agentSource: "user",
            task: "Investigate the slowdown",
            exitCode: -1,
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Thinking out loud" },
                        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "foo.ts" } },
                        { type: "text", text: "Latest partial answer" },
                    ],
                } as any,
            ],
            stderr: "",
            usage: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 46, turns: 1 },
        });

        expect(summary.messages).toEqual([]);
        expect(summary.summaryOnly).toBe(true);
        expect(summary.latestOutput).toBe("Latest partial answer");
        expect(summary.toolCallCount).toBe(1);
        expect(summary.usage.turns).toBe(1);
    });

    test("summarizeResultsForStreaming summarizes every completed result", () => {
        const results = summarizeResultsForStreaming([
            {
                agent: "step-1",
                agentSource: "user",
                task: "First",
                exitCode: 0,
                messages: [{ role: "assistant", content: [{ type: "text", text: "done one" }] } as any],
                stderr: "",
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
            },
            {
                agent: "step-2",
                agentSource: "user",
                task: "Second",
                exitCode: 0,
                messages: [{ role: "assistant", content: [{ type: "text", text: "done two" }] } as any],
                stderr: "",
                usage: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 9, turns: 1 },
            },
        ]);

        expect(results.map((r) => r.messages)).toEqual([[], []]);
        expect(results.map((r) => r.latestOutput)).toEqual(["done one", "done two"]);
    });

    test("shouldSpillParallelOutput measures utf8 bytes, not UTF-16 code units", () => {
        const text = "😀".repeat(30_000);
        expect(text.length).toBeLessThan(PARALLEL_SPILL_THRESHOLD);
        expect(shouldSpillParallelOutput(text)).toBe(true);
    });

    test("sanitizeAgentFileSegment strips path separators and dot prefixes", () => {
        expect(sanitizeAgentFileSegment("../agents/researcher")).toBe("agents-researcher");
        expect(sanitizeAgentFileSegment("a/../../../tmp/pwn")).toBe("a-..-..-..-tmp-pwn");
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
            summaryOnly: true,
            latestOutput: "done",
            toolCallCount: 1,
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

describe("PARALLEL_SPILL_THRESHOLD", () => {
    test("is exported and equals 100KB", () => {
        expect(PARALLEL_SPILL_THRESHOLD).toBe(100 * 1024);
    });

    test("is a reasonable threshold for context window management", () => {
        // Should be at least 10KB (too small = unnecessary file I/O)
        expect(PARALLEL_SPILL_THRESHOLD).toBeGreaterThanOrEqual(10 * 1024);
        // Should be at most 1MB (too large = blows up context)
        expect(PARALLEL_SPILL_THRESHOLD).toBeLessThanOrEqual(1024 * 1024);
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

    test("project config cannot override global subagent limits via loadGlobalConfig", () => {
        const tmp = mkdtempSync(join(tmpdir(), "subagent-config-"));
        _setGlobalConfigDir(tmp);
        // Global config sets conservative limits
        writeFileSync(
            join(tmp, "config.json"),
            JSON.stringify({ subagent: { maxParallelTasks: 4, maxConcurrency: 2 } }),
        );
        // Create a project dir with aggressive limits
        const projectDir = mkdtempSync(join(tmpdir(), "subagent-project-"));
        const { mkdirSync } = require("fs");
        mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
        writeFileSync(
            join(projectDir, ".pizzapi", "config.json"),
            JSON.stringify({ subagent: { maxParallelTasks: 100, maxConcurrency: 50 } }),
        );
        // loadGlobalConfig ignores project config entirely
        const globalConfig = loadGlobalConfig();
        expect(toFinitePositiveInt(globalConfig.subagent?.maxParallelTasks, 8)).toBe(4);
        expect(toFinitePositiveInt(globalConfig.subagent?.maxConcurrency, 4)).toBe(2);
        // loadConfig would merge project over global — verify the difference
        const mergedConfig = loadConfig(projectDir);
        expect(mergedConfig.subagent?.maxParallelTasks).toBe(100); // project wins in merged
        _setGlobalConfigDir(null);
    });
});

describe("parseModelString", () => {
    test("resolves 'haiku' alias", () => {
        expect(parseModelString("haiku")).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    });

    test("resolves 'sonnet' alias", () => {
        expect(parseModelString("sonnet")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-20250514" });
    });

    test("resolves 'opus' alias", () => {
        expect(parseModelString("opus")).toEqual({ provider: "anthropic", id: "claude-opus-4-5" });
    });

    test("resolves aliases case-insensitively", () => {
        expect(parseModelString("Haiku")).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
        expect(parseModelString("SONNET")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-20250514" });
    });

    test("resolves 'provider/id' format", () => {
        expect(parseModelString("google/gemini-2.5-pro")).toEqual({ provider: "google", id: "gemini-2.5-pro" });
    });

    test("resolves bare model ID (assumes anthropic)", () => {
        expect(parseModelString("claude-haiku-4-5")).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    });

    test("returns undefined for 'inherit'", () => {
        expect(parseModelString("inherit")).toBeUndefined();
    });

    test("returns undefined for empty string", () => {
        expect(parseModelString("")).toBeUndefined();
    });

    test("trims whitespace", () => {
        expect(parseModelString("  haiku  ")).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    });
});

describe("selectLightweightModel", () => {
    const makeRegistry = (models: Array<{ provider: string; id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }>) => ({
        find: (provider: string, modelId: string) => models.find(m => m.provider === provider && m.id === modelId) as any,
        getAvailable: () => models as any[],
    });

    test("selects the cheapest model by output cost", () => {
        const registry = makeRegistry([
            { provider: "anthropic", id: "claude-opus-4-5", cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
            { provider: "anthropic", id: "claude-sonnet-4", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
            { provider: "anthropic", id: "claude-haiku-4-5", cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
        ]);
        const selected = selectLightweightModel(registry);
        expect(selected).toBeDefined();
        expect(selected!.id).toBe("claude-haiku-4-5");
    });

    test("returns undefined when no models are available", () => {
        const registry = makeRegistry([]);
        expect(selectLightweightModel(registry)).toBeUndefined();
    });

    test("returns the only model if just one is available", () => {
        const registry = makeRegistry([
            { provider: "google", id: "gemini-2.5-pro", cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 } },
        ]);
        const selected = selectLightweightModel(registry);
        expect(selected).toBeDefined();
        expect(selected!.id).toBe("gemini-2.5-pro");
    });

    test("selects across providers when multiple are available", () => {
        const registry = makeRegistry([
            { provider: "anthropic", id: "claude-opus-4-5", cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 } },
            { provider: "google", id: "gemini-2.5-flash", cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 } },
            { provider: "anthropic", id: "claude-haiku-4-5", cost: { input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 } },
        ]);
        const selected = selectLightweightModel(registry);
        expect(selected!.id).toBe("gemini-2.5-flash");
    });

    test("does not mutate the registry's model array", () => {
        const models = [
            { provider: "anthropic", id: "opus", cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 } },
            { provider: "anthropic", id: "haiku", cost: { input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 } },
        ];
        const registry = makeRegistry(models);
        selectLightweightModel(registry);
        expect(models[0].id).toBe("opus"); // not reordered
    });
});
