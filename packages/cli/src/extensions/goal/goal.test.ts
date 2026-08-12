/**
 * Unit tests for the `/goal` parser and state module.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseGoalArgs, tokenizeGoalArgs } from "./parser.js";
import {
    checkBudget,
    clearGoal,
    formatGoalStatus,
    getGoal,
    getPendingGuidance,
    recordCompletedRun,
    recordEvaluation,
    recordTurnSpend,
    resetSession,
    restoreGoal,
    setGoal,
    setPendingGuidance,
} from "./state.js";
import {
    keywordGoalEvaluator,
    parseLlmVerdict,
    createLlmGoalEvaluator,
    createSessionCacheEvaluator,
    resolveEvaluatorModel,
} from "./evaluator.js";
import {
    captureSessionContext,
    isCacheReuseViable,
    recordCacheOutcome,
    resetSessionContext,
    toLlmMessages,
} from "./session-context.js";
import { extractLatestTurnText, buildTranscript, extractAgentMessageText } from "./transcript.js";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import type { GoalState, GoalVerdict } from "./types.js";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ModelRegistry,
    TurnEndEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { goalExtension } from "./index.js";

function fakeAppendEntry(_customType: string, _data: unknown): void {
    /* no-op for tests */
}

function makeGoal(): GoalState {
    return setGoal(
        "session-1",
        { description: "the tests pass", evaluator: "keyword", successKeywords: ["tests pass"], minTurnsBeforeEvaluate: 0 },
        { maxTurns: 3, maxTokens: 1000 },
        { appendEntry: fakeAppendEntry },
    );
}

describe("tokenizeGoalArgs", () => {
    test("splits bare words", () => {
        expect(tokenizeGoalArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
    });

    test("honors double quotes", () => {
        expect(tokenizeGoalArgs('foo "bar baz" qux')).toEqual(["foo", "bar baz", "qux"]);
    });

    test("trims extra spaces", () => {
        expect(tokenizeGoalArgs("  foo   bar  ")).toEqual(["foo", "bar"]);
    });
});

describe("parseGoalArgs", () => {
    test("parses a plain condition", () => {
        const parsed = parseGoalArgs("the tests pass");
        expect(parsed.rawCondition).toBe("the tests pass");
        expect(parsed.condition.evaluator).toBe("llm");
        expect(parsed.budget).toEqual({});
    });

    test("parses budgets and keywords", () => {
        const parsed = parseGoalArgs('"the tests pass" --max-turns 10 --max-tokens 50000 --evaluator keyword --keyword "tests pass"');
        expect(parsed.rawCondition).toBe("the tests pass");
        expect(parsed.condition.evaluator).toBe("keyword");
        expect(parsed.condition.successKeywords).toEqual(["tests pass"]);
        expect(parsed.budget).toEqual({ maxTurns: 10, maxTokens: 50000 });
    });

    test("treats bare /goal as status", () => {
        const parsed = parseGoalArgs("");
        expect(parsed.statusOnly).toBe(true);
    });

    test("treats /goal status as status", () => {
        const parsed = parseGoalArgs("status");
        expect(parsed.statusOnly).toBe(true);
    });

    test.each([["clear"], ["stop"], ["off"], ["cancel"], ["reset"], ["none"]])("treats /goal %s as clear", (alias) => {
        const parsed = parseGoalArgs(alias);
        expect(parsed.clear).toBe(true);
        expect(parsed.statusOnly).toBe(false);
    });



    test("rejects missing condition", () => {
        expect(() => parseGoalArgs("--max-turns 5")).toThrow("A goal condition is required");
    });

    test.each([["--max-turns"], ["--max-tokens"], ["--max-cost"]])("rejects a zero or negative %s budget", (flag) => {
        // A zero budget is exhausted before the first run — always a typo.
        expect(() => parseGoalArgs(`the tests pass ${flag} 0`)).toThrow("must be a positive number");
        expect(() => parseGoalArgs(`the tests pass ${flag} -1`)).toThrow("must be a positive number");
    });

    test("treats unknown flags as condition text", () => {
        const parsed = parseGoalArgs("fix the --dry-run handling");
        expect(parsed.rawCondition).toBe("fix the --dry-run handling");
        expect(parsed.budget).toEqual({});
    });

    test("rejects keyword evaluator without keywords", () => {
        expect(() => parseGoalArgs("build passes --evaluator keyword")).toThrow("requires at least one --keyword");
    });

    test("parses --every as the LLM evaluator cadence", () => {
        const parsed = parseGoalArgs('"the tests pass" --every 5');
        expect(parsed.condition.evaluateEveryNTurns).toBe(5);
    });

    test("rejects --every with a non-positive-integer value", () => {
        expect(() => parseGoalArgs("the tests pass --every 0")).toThrow("positive integer");
        expect(() => parseGoalArgs("the tests pass --every 1.5")).toThrow("positive integer");
    });

    test("parses --min-turns as the minimum turns before first evaluation", () => {
        const parsed = parseGoalArgs('"the tests pass" --min-turns 5');
        expect(parsed.condition.minTurnsBeforeEvaluate).toBe(5);
    });

    test("rejects --min-turns with a non-positive-integer value", () => {
        expect(() => parseGoalArgs("the tests pass --min-turns 0")).toThrow("positive integer");
        expect(() => parseGoalArgs("the tests pass --min-turns 1.5")).toThrow("positive integer");
    });

    test("leaves minTurnsBeforeEvaluate undefined when --min-turns is omitted", () => {
        const parsed = parseGoalArgs("the tests pass");
        expect(parsed.condition.minTurnsBeforeEvaluate).toBeUndefined();
    });
});

describe("goal state", () => {
    test("setGoal stores active state", () => {
        resetSession("session-1");
        const state = makeGoal();
        expect(state.condition.description).toBe("the tests pass");
        expect(state.status).toBe("active");
        expect(getGoal("session-1")?.id).toBe(state.id);
    });

    test("recordEvaluation caps the persisted history", () => {
        resetSession("session-1");
        makeGoal();
        for (let i = 0; i < 25; i++) {
            recordEvaluation("session-1", {
                turnIndex: i,
                verdict: "not_met",
                reason: `turn ${i}`,
                timestamp: Date.now(),
            }, { appendEntry: fakeAppendEntry });
        }
        const state = getGoal("session-1")!;
        expect(state.evaluations.length).toBe(20);
        expect(state.evaluations.at(-1)?.reason).toBe("turn 24");
        expect(state.evaluations[0]?.reason).toBe("turn 5");
    });

    test("recordTurnSpend accrues spend without counting a run", () => {
        resetSession("session-1");
        makeGoal();
        const updated = recordTurnSpend("session-1", 123, 0.001);
        expect(updated?.tokenSpend).toBe(123);
        expect(updated?.costSpend).toBe(0.001);
        // Mid-run tool-call turns spend but do not advance the run counter.
        expect(updated?.turnCount).toBe(0);
    });

    test("recordCompletedRun advances turnCount only", () => {
        resetSession("session-1");
        makeGoal();
        recordTurnSpend("session-1", 100, 0.002);
        recordTurnSpend("session-1", 50, 0.001);
        const updated = recordCompletedRun("session-1");
        expect(updated?.turnCount).toBe(1);
        expect(updated?.tokenSpend).toBe(150);
        expect(updated?.costSpend).toBeCloseTo(0.003, 10);
    });

    test("recordEvaluation stamps lastEvaluatedTurn", () => {
        resetSession("session-1");
        makeGoal();
        recordCompletedRun("session-1");
        recordCompletedRun("session-1");
        const state = recordEvaluation("session-1", {
            turnIndex: 2,
            verdict: "not_met",
            reason: "still working",
            timestamp: Date.now(),
        }, { appendEntry: fakeAppendEntry });
        expect(state?.lastEvaluatedTurn).toBe(2);
    });

    test("recordEvaluation appends a goal_evaluator_usage entry when the LLM evaluator spends tokens/cost", () => {
        resetSession("session-1");
        makeGoal();
        const entries: Array<{ customType: string; data: unknown }> = [];
        const appendEntry = (customType: string, data: unknown) => entries.push({ customType, data });

        recordEvaluation("session-1", {
            turnIndex: 0,
            verdict: "not_met",
            reason: "still working",
            tokensUsed: 42,
            cost: 0.0007,
            model: { provider: "anthropic", id: "claude-haiku" },
            timestamp: Date.now(),
        }, { appendEntry });

        const usageEntries = entries.filter((e) => e.customType === "goal_evaluator_usage");
        expect(usageEntries.length).toBe(1);
        expect(usageEntries[0].data).toMatchObject({
            provider: "anthropic",
            model: "claude-haiku",
            tokens: 42,
            cost: 0.0007,
        });
    });

    test("recordEvaluation skips the usage entry for the keyword evaluator (no cost/tokens)", () => {
        resetSession("session-1");
        makeGoal();
        const entries: Array<{ customType: string; data: unknown }> = [];
        const appendEntry = (customType: string, data: unknown) => entries.push({ customType, data });

        recordEvaluation("session-1", {
            turnIndex: 0,
            verdict: "not_met",
            reason: "no keyword match",
            timestamp: Date.now(),
        }, { appendEntry });

        expect(entries.some((e) => e.customType === "goal_evaluator_usage")).toBe(false);
    });

    test("keyword evaluator marks goal met", async () => {
        resetSession("session-1");
        makeGoal();
        recordTurnSpend("session-1", 10, 0);
        recordCompletedRun("session-1");
        const feedback = await keywordGoalEvaluator.evaluate(getGoal("session-1")!, {
            latestTurnText: "All tests pass!",
            transcript: "",
            history: [],
            turnCount: 1,
            tokenSpend: 10,
        });
        expect(feedback.verdict).toBe("met");
        const state = recordEvaluation("session-1", feedback, { appendEntry: fakeAppendEntry });
        expect(state?.status).toBe("met");
        expect(state?.stopReason).toBe("goal_met");
    });

    test("max turns budget stops the goal", () => {
        resetSession("session-1");
        makeGoal();
        recordCompletedRun("session-1");
        recordCompletedRun("session-1");
        const state = recordCompletedRun("session-1");
        expect(state?.turnCount).toBe(3);
        expect(checkBudget(state!)).toBe("max_turns");
        expect(state?.status).toBe("failed");
    });

    test("max tokens budget stops the goal", () => {
        resetSession("session-1");
        makeGoal();
        const state = recordTurnSpend("session-1", 1000, 0);
        expect(checkBudget(state!)).toBe("max_tokens");
    });

    test("clearGoal cancels active goal", () => {
        resetSession("session-1");
        makeGoal();
        const result = clearGoal("session-1", { appendEntry: fakeAppendEntry });
        expect(result.success).toBe(true);
        expect(getGoal("session-1")?.status).toBe("cancelled");
    });

    test("restoreGoal loads latest persisted active goal", () => {
        resetSession("session-1");
        const persisted = {
            version: 1 as const,
            id: "goal_123",
            condition: { description: "foo", evaluator: "keyword" as const },
            budget: { maxTurns: 5 },
            status: "active" as const,
            turnCount: 2,
            tokenSpend: 100,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };
        const restored = restoreGoal("session-1", [
            { type: "custom", customType: "goal_state", data: persisted },
        ]);
        expect(restored?.id).toBe("goal_123");
        expect(restored?.turnCount).toBe(2);
    });

    test("cleanupStaleGoals removes stopped goals older than 24 hours", () => {
        resetSession("session-old");
        resetSession("session-new");
        const oldState = setGoal(
            "session-old",
            { description: "old", evaluator: "keyword", successKeywords: ["done"], minTurnsBeforeEvaluate: 0 },
            {},
            { appendEntry: fakeAppendEntry },
        );
        // Simulate the goal being met more than 24 hours ago.
        recordEvaluation("session-old", {
            turnIndex: 1,
            verdict: "met",
            reason: "done",
            timestamp: Date.now(),
        }, { appendEntry: fakeAppendEntry });
        const stale = getGoal("session-old")!;
        stale.stoppedAt = Date.now() - 25 * 60 * 60 * 1000;

        setGoal(
            "session-new",
            { description: "new", evaluator: "keyword", successKeywords: ["done"], minTurnsBeforeEvaluate: 0 },
            {},
            { appendEntry: fakeAppendEntry },
        );

        expect(getGoal("session-old")).toBeUndefined();
        expect(getGoal("session-new")).toBeDefined();
    });

    test("formatGoalStatus renders budgets", () => {
        resetSession("session-1");
        const state = makeGoal();
        const text = formatGoalStatus(state);
        expect(text).toContain("Goal: the tests pass");
        expect(text).toContain("Budget: turns ≤ 3, tokens ≤ 1,000");
    });
});

describe("extractLatestTurnText", () => {
    test("extracts assistant text content", () => {
        const text = extractLatestTurnText({
            assistantContent: [
                { type: "text", text: "Hello" },
                { type: "text", text: "world" },
            ],
        });
        expect(text).toBe("Hello\nworld");
    });

    test("extracts assistant string content", () => {
        expect(extractLatestTurnText({ assistantContent: "plain text" })).toBe("plain text");
    });

    test("extracts tool result text", () => {
        const text = extractLatestTurnText({
            toolResults: [
                { content: [{ type: "text", text: "result one" }] },
                { text: "result two" },
            ],
        });
        expect(text).toBe("result one\n\nresult two");
    });

    test("prefers explicit assistantText over content", () => {
        const text = extractLatestTurnText({
            assistantText: "explicit",
            assistantContent: [{ type: "text", text: "ignored" }],
        });
        expect(text).toBe("explicit");
    });
});

describe("buildTranscript", () => {
    test("formats message entries", () => {
        const transcript = buildTranscript([
            {
                type: "message",
                message: { role: "user", content: "hi", timestamp: 1 },
                id: "1",
                parentId: null,
                timestamp: "1",
            },
            {
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "hello" }], api: "anthropic-messages", provider: "anthropic", model: "haiku", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
                id: "2",
                parentId: "1",
                timestamp: "2",
            },
            {
                type: "message",
                message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
                id: "3",
                parentId: "2",
                timestamp: "3",
            },
        ] as any[], 1000);
        expect(transcript).toContain("User:\nhi");
        expect(transcript).toContain("Assistant:\nhello");
        expect(transcript).toContain("Tool (bash):\nok");
    });

    test("truncates long transcripts from the front", () => {
        const longText = "a".repeat(3000);
        const transcript = buildTranscript([
            {
                type: "message",
                message: { role: "user", content: longText, timestamp: 1 },
                id: "1",
                parentId: null,
                timestamp: "1",
            },
            {
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "end" }], api: "anthropic-messages", provider: "anthropic", model: "haiku", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
                id: "2",
                parentId: "1",
                timestamp: "2",
            },
        ] as any[], 1000);
        expect(transcript.startsWith("...truncated...")).toBe(true);
        expect(transcript).toContain("end");
        expect(transcript).not.toContain(longText);
    });

    test("redacts common env-var secrets from transcript", () => {
        const transcript = buildTranscript([
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolCallId: "t1",
                    toolName: "bash",
                    content: [{ type: "text", text: "export PIZZAPI_AUTH_TOKEN=abc123\nOPENAI_API_KEY: sk-secret\nANTHROPIC_API_KEY=other" }],
                    isError: false,
                    timestamp: 1,
                },
                id: "1",
                parentId: null,
                timestamp: "1",
            },
        ] as any[], 1000);
        expect(transcript).toContain("PIZZAPI_AUTH_TOKEN=[REDACTED]");
        expect(transcript).toContain("OPENAI_API_KEY:[REDACTED]");
        expect(transcript).toContain("ANTHROPIC_API_KEY=[REDACTED]");
        expect(transcript).not.toContain("abc123");
        expect(transcript).not.toContain("sk-secret");
        expect(transcript).not.toContain("other");
    });
});

describe("parseLlmVerdict", () => {
    test.each([
        ["Decision: yes\nReason: tests pass", "met", "tests pass"],
        ["Decision: no\nReason: still failing", "not_met", "still failing"],
        ["Decision: met\nReason: done", "met", "done"],
        ["Decision: not_met\nReason: incomplete", "not_met", "incomplete"],
        ["Decision: not met\nReason: incomplete", "not_met", "incomplete"],
    ])("parses %p as %p", (input, verdict, reason) => {
        const result = parseLlmVerdict(input);
        expect(result.verdict).toBe(verdict as GoalVerdict);
        expect(result.reason).toBe(reason);
    });

    test.each([
        ['{"verdict": "yes", "reason": "tests pass"}', "met", "tests pass"],
        ['{"verdict": "no", "reason": "still failing"}', "not_met", "still failing"],
        ['{"verdict": "met", "reason": "done"}', "met", "done"],
        ['{"verdict": "not_met", "reason": "incomplete"}', "not_met", "incomplete"],
        ['{"verdict": "not met", "reason": "incomplete"}', "not_met", "incomplete"],
        ['{"verdict": "true"}', "met", ""],
        ['{"verdict": "false"}', "not_met", ""],
    ])("parses JSON %p as %p", (input, verdict, reason) => {
        const result = parseLlmVerdict(input);
        expect(result.verdict).toBe(verdict as GoalVerdict);
        expect(result.reason).toBe(reason);
    });

    test("returns uncertain for ambiguous responses", () => {
        expect(parseLlmVerdict("maybe later").verdict).toBe("uncertain");
    });

    test("parses JSON whose reason contains braces", () => {
        const result = parseLlmVerdict('{"verdict": "no", "reason": "the {foo} handler still throws"}');
        expect(result.verdict).toBe("not_met");
        expect(result.reason).toBe("the {foo} handler still throws");
    });

    test("parses JSON followed by trailing prose containing braces", () => {
        const result = parseLlmVerdict('{"verdict": "yes", "reason": "all green"}\nNote: check {config} next.');
        expect(result.verdict).toBe("met");
        expect(result.reason).toBe("all green");
    });

    test.each([
        ["The goal has not been met yet"],
        ["The goal has not yet been met"],
        ["The condition hasn't been met"],
        ["The goal was never met"],
    ])("parses negated free-text %p as not_met", (input) => {
        expect(parseLlmVerdict(input).verdict).toBe("not_met");
    });
});

describe("resolveEvaluatorModel", () => {
    function makeRegistry(models: Array<Partial<Model<any>> & { id: string; provider: string }>): ModelRegistry {
        return {
            getAll: () => models as Model<any>[],
            hasConfiguredAuth: (m: Model<any>) => m.provider !== "unauthenticated",
            getApiKeyAndHeaders: async (m: Model<any>) =>
                m.provider === "unauthenticated"
                    ? { ok: false as const, error: "no key" }
                    : { ok: true as const, apiKey: `${m.provider}-key` },
        } as unknown as ModelRegistry;
    }

    test("returns configured model by id", async () => {
        const registry = makeRegistry([
            { provider: "anthropic", id: "claude-haiku-4-5", input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096, reasoning: false, name: "Haiku", api: "anthropic-messages", baseUrl: "" },
        ]);
        const resolved = await resolveEvaluatorModel(registry, "claude-haiku-4-5");
        expect(resolved?.model.id).toBe("claude-haiku-4-5");
        expect(resolved?.apiKey).toBe("anthropic-key");
    });

    test("returns configured model by provider:id", async () => {
        const registry = makeRegistry([
            { provider: "openai", id: "gpt-4o-mini", input: ["text"], cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096, reasoning: false, name: "Mini", api: "openai-completions", baseUrl: "" },
            { provider: "anthropic", id: "claude-haiku-4-5", input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096, reasoning: false, name: "Haiku", api: "anthropic-messages", baseUrl: "" },
        ]);
        const resolved = await resolveEvaluatorModel(registry, "openai:gpt-4o-mini");
        expect(resolved?.model.provider).toBe("openai");
        expect(resolved?.model.id).toBe("gpt-4o-mini");
    });

    test("falls back to the cheapest authenticated text model", async () => {
        const registry = makeRegistry([
            { provider: "anthropic", id: "claude-opus", input: ["text"], cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096, reasoning: false, name: "Opus", api: "anthropic-messages", baseUrl: "" },
            { provider: "openai", id: "gpt-4o-mini", input: ["text"], cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096, reasoning: false, name: "Mini", api: "openai-completions", baseUrl: "" },
            { provider: "groq", id: "llama-8b", input: ["text"], cost: { input: 0.05, output: 0.08, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, maxTokens: 4096, reasoning: false, name: "Llama", api: "openai-completions", baseUrl: "" },
        ]);
        const resolved = await resolveEvaluatorModel(registry);
        expect(resolved?.model.provider).toBe("groq");
        expect(resolved?.model.id).toBe("llama-8b");
    });

    test("ignores models without configured auth", async () => {
        const registry = makeRegistry([
            { provider: "unauthenticated", id: "cheap-model", input: ["text"], cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, maxTokens: 4096, reasoning: false, name: "Cheap", api: "openai-completions", baseUrl: "" },
            { provider: "openai", id: "gpt-4o-mini", input: ["text"], cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096, reasoning: false, name: "Mini", api: "openai-completions", baseUrl: "" },
        ]);
        const resolved = await resolveEvaluatorModel(registry);
        expect(resolved?.model.id).toBe("gpt-4o-mini");
    });

    test("returns undefined when nothing is available", async () => {
        const registry = makeRegistry([]);
        const resolved = await resolveEvaluatorModel(registry);
        expect(resolved).toBeUndefined();
    });

    test("does not prefer an expensive session model — unconfigured resolves cheapest", async () => {
        // The evaluator prompt shares no prefix with the session context, so
        // there is no prompt cache to hit by reusing the session's model.
        const registry = makeRegistry([
            { provider: "anthropic", id: "claude-opus", input: ["text"], cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096, reasoning: false, name: "Opus", api: "anthropic-messages", baseUrl: "" },
            { provider: "openai", id: "gpt-4o-mini", input: ["text"], cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096, reasoning: false, name: "Mini", api: "openai-completions", baseUrl: "" },
        ]);
        const resolved = await resolveEvaluatorModel(registry);
        expect(resolved?.model.id).toBe("gpt-4o-mini");
    });

    test("falls back to the cheapest text model when the configured model lacks auth", async () => {
        const registry = makeRegistry([
            { provider: "unauthenticated", id: "pinned", input: ["text"], cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, maxTokens: 4096, reasoning: false, name: "Pinned", api: "openai-completions", baseUrl: "" },
            { provider: "openai", id: "gpt-4o-mini", input: ["text"], cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096, reasoning: false, name: "Mini", api: "openai-completions", baseUrl: "" },
        ]);
        const resolved = await resolveEvaluatorModel(registry, "unauthenticated:pinned");
        expect(resolved?.model.id).toBe("gpt-4o-mini");
    });
});

describe("createLlmGoalEvaluator", () => {
    test("returns met when model says yes", async () => {
        const state: GoalState = {
            id: "g1",
            condition: { description: "tests pass", evaluator: "llm" },
            budget: {},
            status: "active",
            turnCount: 1,
            tokenSpend: 0,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };

        const completeSimple = async (_model: Model<any>, context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
            const prompt = typeof context.messages[0]!.content === "string"
                ? context.messages[0]!.content
                : "";
            expect(prompt).toContain("Goal: tests pass");
            return {
                role: "assistant",
                content: [{ type: "text", text: "Decision: yes\nReason: all green" }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "haiku",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop",
                timestamp: Date.now(),
            };
        };

        const evaluator = createLlmGoalEvaluator({
            completeSimple,
            model: { id: "haiku", provider: "anthropic" } as Model<any>,
            maxTokens: 128,
        });

        const feedback = await evaluator.evaluate(state, {
            latestTurnText: "tests passed",
            transcript: "User: run tests\nAssistant: passed",
            history: [],
            turnCount: 1,
            tokenSpend: 0,
        });

        expect(feedback.verdict).toBe("met");
        expect(feedback.reason).toBe("all green");
        expect(feedback.tokensUsed).toBe(15);
    });

    test("returns not_met guidance when model says no", async () => {
        const state: GoalState = {
            id: "g1",
            condition: { description: "docker builds", evaluator: "llm" },
            budget: {},
            status: "active",
            turnCount: 2,
            tokenSpend: 100,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };

        const completeSimple = async (): Promise<AssistantMessage> => ({
            role: "assistant",
            content: [{ type: "text", text: "Decision: no\nReason: missing Dockerfile" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "haiku",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
        });

        const evaluator = createLlmGoalEvaluator({
            completeSimple,
            model: { id: "haiku", provider: "anthropic" } as Model<any>,
        });

        const feedback = await evaluator.evaluate(state, {
            latestTurnText: "image build failed",
            transcript: "",
            history: [],
            turnCount: 2,
            tokenSpend: 100,
        });

        expect(feedback.verdict).toBe("not_met");
        expect(feedback.reason).toBe("missing Dockerfile");
    });

    test("handles model errors gracefully", async () => {
        const state: GoalState = {
            id: "g1",
            condition: { description: "x", evaluator: "llm" },
            budget: {},
            status: "active",
            turnCount: 1,
            tokenSpend: 0,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };

        const completeSimple = async (): Promise<AssistantMessage> => {
            throw new Error("network down");
        };

        const evaluator = createLlmGoalEvaluator({
            completeSimple,
            model: { id: "haiku", provider: "anthropic" } as Model<any>,
        });

        const feedback = await evaluator.evaluate(state, {
            latestTurnText: "",
            transcript: "",
            history: [],
            turnCount: 1,
            tokenSpend: 0,
        });

        expect(feedback.verdict).toBe("uncertain");
        expect(feedback.reason).toContain("network down");
    });
});

describe("createSessionCacheEvaluator", () => {
    const captured = {
        systemPrompt: "You are a coding agent.",
        messages: [
            { role: "user" as const, content: "run the tests", timestamp: 1 },
            {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "running them" }],
                api: "anthropic-messages" as const,
                provider: "anthropic",
                model: "sonnet",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop" as const,
                timestamp: 2,
            },
        ],
        tools: [{ name: "bash", description: "run a command", parameters: {} }],
        capturedAt: 1,
    };

    function makeState(): GoalState {
        return {
            id: "g1",
            condition: { description: "tests pass", evaluator: "llm" },
            budget: {},
            status: "active",
            turnCount: 1,
            tokenSpend: 0,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };
    }

    function makeResponse(text: string, cacheRead: number): AssistantMessage {
        return {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "sonnet",
            usage: { input: 120, output: 20, cacheRead, cacheWrite: 0, totalTokens: 140 + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
            stopReason: "stop",
            timestamp: Date.now(),
        };
    }

    test("re-sends the session prefix verbatim and appends the judge question", async () => {
        let seen: Context | undefined;
        const evaluator = createSessionCacheEvaluator({
            completeSimple: async (_model, context) => {
                seen = context;
                return makeResponse('{"verdict": "no", "reason": "tests still failing"}', 900);
            },
            model: { id: "sonnet", provider: "anthropic" } as Model<any>,
            captured,
        });

        const feedback = await evaluator.evaluate(makeState(), {
            latestTurnText: "3 tests failed",
            transcript: "",
            history: [],
            turnCount: 1,
            tokenSpend: 0,
        });

        // The cached prefix must be byte-identical to what the session sent:
        // same system prompt, same tools, same messages in the same order.
        expect(seen?.systemPrompt).toBe(captured.systemPrompt);
        expect(seen?.tools).toEqual(captured.tools);
        expect(seen?.messages.slice(0, 2)).toEqual(captured.messages);

        // Only a trailing user message is added — the shape of a normal
        // follow-up turn, so the provider always accepts the sequence.
        expect(seen?.messages).toHaveLength(3);
        const appended = seen!.messages[2]!;
        expect(appended.role).toBe("user");
        expect(appended.content as string).toContain("tests pass");
        expect(appended.content as string).toContain("3 tests failed");

        expect(feedback.verdict).toBe("not_met");
        expect(feedback.cacheReadTokens).toBe(900);
    });

    test("does not resend the transcript — the cached conversation is the transcript", async () => {
        let seen: Context | undefined;
        const evaluator = createSessionCacheEvaluator({
            completeSimple: async (_model, context) => {
                seen = context;
                return makeResponse('{"verdict": "yes", "reason": "all green"}', 900);
            },
            model: { id: "sonnet", provider: "anthropic" } as Model<any>,
            captured,
        });

        await evaluator.evaluate(makeState(), {
            latestTurnText: "done",
            transcript: "SHOULD-NOT-BE-SENT",
            history: [],
            turnCount: 1,
            tokenSpend: 0,
        });

        expect(JSON.stringify(seen?.messages)).not.toContain("SHOULD-NOT-BE-SENT");
    });

    test("reports a zero cache read so the caller can abandon the path", async () => {
        const evaluator = createSessionCacheEvaluator({
            completeSimple: async () => makeResponse('{"verdict": "no", "reason": "nope"}', 0),
            model: { id: "sonnet", provider: "anthropic" } as Model<any>,
            captured,
        });

        const feedback = await evaluator.evaluate(makeState(), {
            latestTurnText: "",
            transcript: "",
            history: [],
            turnCount: 1,
            tokenSpend: 0,
        });

        expect(feedback.cacheReadTokens).toBe(0);
    });

    test("handles model errors gracefully", async () => {
        const evaluator = createSessionCacheEvaluator({
            completeSimple: async () => {
                throw new Error("network down");
            },
            model: { id: "sonnet", provider: "anthropic" } as Model<any>,
            captured,
        });

        const feedback = await evaluator.evaluate(makeState(), {
            latestTurnText: "",
            transcript: "",
            history: [],
            turnCount: 1,
            tokenSpend: 0,
        });

        expect(feedback.verdict).toBe("uncertain");
        expect(feedback.reason).toContain("network down");
    });
});

describe("toLlmMessages", () => {
    test("drops custom agent messages that never reach the provider", () => {
        // The `context` event fires before pi's convertToLlm step, so the
        // array can still contain PizzaPi's own message types (e.g. background
        // bash execution). Sending those verbatim would not match what pi
        // actually serialized.
        const messages = [
            { role: "user", content: "run it", timestamp: 1 },
            { role: "bashExecution", command: "ls", output: "a b c", timestamp: 2 },
            { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 },
            { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 4 },
        ] as any[];

        const result = toLlmMessages(messages);
        expect(result.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    });

    test("preserves order and passes through a clean transcript untouched", () => {
        const messages = [
            { role: "user", content: "one", timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 },
        ] as any[];
        expect(toLlmMessages(messages)).toEqual(messages);
    });
});

describe("session context cache tracking", () => {
    test("a cache read keeps the path viable; a miss disables it once", () => {
        resetSessionContext("cache-session");
        captureSessionContext("cache-session", {
            systemPrompt: "sys",
            messages: [{ role: "user", content: "hi", timestamp: 1 }],
            tools: [],
            capturedAt: 1,
        });

        expect(isCacheReuseViable("cache-session")).toBe(true);
        expect(recordCacheOutcome("cache-session", 500)).toBe(false);
        expect(isCacheReuseViable("cache-session")).toBe(true);

        // First miss disables reuse and reports the downgrade exactly once,
        // so the warning isn't repeated every evaluation.
        expect(recordCacheOutcome("cache-session", 0)).toBe(true);
        expect(isCacheReuseViable("cache-session")).toBe(false);
        expect(recordCacheOutcome("cache-session", 0)).toBe(false);

        resetSessionContext("cache-session");
        expect(isCacheReuseViable("cache-session")).toBe(true);
    });
});

describe("pending guidance", () => {
    test("setPendingGuidance stores and getPendingGuidance retrieves", () => {
        resetSession("session-1");
        setPendingGuidance("session-1", "fix the typo");
        expect(getPendingGuidance("session-1")).toBe("fix the typo");
    });

    test("resetSession clears pending guidance", () => {
        setPendingGuidance("session-2", "refactor");
        resetSession("session-2");
        expect(getPendingGuidance("session-2")).toBeUndefined();
    });

    test("setGoal clears previous pending guidance", () => {
        setPendingGuidance("session-1", "old guidance");
        makeGoal();
        expect(getPendingGuidance("session-1")).toBeUndefined();
    });

    test("clearGoal clears pending guidance", () => {
        makeGoal();
        setPendingGuidance("session-1", "old guidance");
        clearGoal("session-1", { appendEntry: fakeAppendEntry });
        expect(getPendingGuidance("session-1")).toBeUndefined();
    });
});

// ── Integration tests for the extension event wiring ─────────────────────────

function createFakePi(): {
    pi: ExtensionAPI;
    handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
    messages: Array<{ customType: string; content: string; display: boolean }>;
    userMessages: Array<{ content: string; options?: { deliverAs?: string } }>;
    entries: Array<{ customType: string; data: unknown }>;
    events: Map<string, unknown[]>;
    commands: Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>;
} {
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];
    const userMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    const events = new Map<string, unknown[]>();
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();

    const pi = {
        on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        sendMessage: (msg: { customType: string; content: string; display: boolean }) => {
            messages.push(msg);
        },
        sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
            userMessages.push({ content, options });
        },
        appendEntry: (customType: string, data?: unknown) => {
            entries.push({ customType, data });
        },
        registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) => {
            commands.set(name, options.handler);
        },
        events: {
            emit: (event: string, payload: unknown) => {
                const list = events.get(event) ?? [];
                list.push(payload);
                events.set(event, list);
            },
        },
    } as unknown as ExtensionAPI;

    return { pi, handlers, messages, userMessages, entries, events, commands };
}

function createFakeCtx(overrides: {
    entries?: SessionEntry[];
    shutdown?: () => void;
    signal?: AbortSignal;
    pendingMessages?: boolean;
} = {}): ExtensionContext {
    return {
        cwd: "/tmp/pizzapi-goal-test",
        sessionManager: {
            getSessionId: () => "session-1",
            getEntries: () => overrides.entries ?? [],
        },
        modelRegistry: {
            getAll: () => [],
            hasConfiguredAuth: () => false,
        },
        model: undefined,
        signal: overrides.signal ?? undefined,
        shutdown: overrides.shutdown ?? (() => {}),
        ui: {
            setStatus: (_key: string, _text?: string) => {},
        },
        hasPendingMessages: () => overrides.pendingMessages ?? false,
    } as unknown as ExtensionContext;
}

function makeAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "haiku",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
        stopReason,
        timestamp: Date.now(),
    };
}

/** A mid-run turn: the agent called tools and will keep going by itself. */
function makeToolUseMessage(text: string): AssistantMessage {
    return makeAssistantMessage(text, "toolUse");
}

describe("goalExtension event wiring", () => {
    let originalSessionId: string | undefined;

    beforeEach(() => {
        originalSessionId = process.env.PIZZAPI_SESSION_ID;
        process.env.PIZZAPI_SESSION_ID = "session-1";
    });

    afterEach(() => {
        if (originalSessionId === undefined) {
            delete process.env.PIZZAPI_SESSION_ID;
        } else {
            process.env.PIZZAPI_SESSION_ID = originalSessionId;
        }
    });

    test("turn_end keyword goal met does not stop session", async () => {
        resetSession("session-1");
        const { pi, handlers, messages } = createFakePi();
        let shutdownCalled = false;
        const ctx = createFakeCtx({ shutdown: () => { shutdownCalled = true; } });

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            { maxTurns: 10 },
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("All tests pass"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("met");
        expect(getGoal("session-1")?.stopReason).toBe("goal_met");
        expect(shutdownCalled).toBe(false);
        expect(messages.some((m) => m.content.includes("Goal met"))).toBe(true);
    });

    test("does not auto-continue when background subagents or queued messages are pending", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx({ pendingMessages: true });

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("Still failing"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("active");
        expect(getPendingGuidance("session-1")).toBeUndefined();
        expect(userMessages.length).toBe(0);
    });

    test("turn_end from a rate-limit error leaves the goal idle for a user follow-up", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: { ...makeAssistantMessage(""), stopReason: "error", errorMessage: "rate limit exceeded" },
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("active");
        expect(getGoal("session-1")?.turnCount).toBe(0);
        expect(getPendingGuidance("session-1")).toBeUndefined();
        expect(userMessages).toHaveLength(0);
    });

    test("turn_end keyword not met stores guidance and auto-continues the loop", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("Still failing"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("active");
        expect(getPendingGuidance("session-1")).toContain("pass");
        // The goal loop keeps working: a not_met verdict triggers another turn,
        // delivered as a steering message so it isn't stuck behind the queue.
        expect(userMessages.length).toBe(1);
        expect(userMessages[0]!.content).toContain("Goal not met");
        expect(userMessages[0]!.content).toContain("tests pass");
        expect(userMessages[0]!.options?.deliverAs).toBe("steer");
    });

    test("turn_end goal met does not auto-continue", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("All tests pass"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("met");
        expect(userMessages.length).toBe(0);
    });

    test("setting a goal kicks off a turn with the condition as directive", async () => {
        resetSession("session-1");
        const { pi, commands, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        const goalHandler = commands.get("goal")!;
        await goalHandler("tests pass --evaluator keyword --keyword pass", ctx as ExtensionCommandContext);

        expect(userMessages.length).toBe(1);
        expect(userMessages[0]!.content).toContain("tests pass");

        // Status and clear do not kick off turns.
        await goalHandler("status", ctx as ExtensionCommandContext);
        await goalHandler("clear", ctx as ExtensionCommandContext);
        expect(userMessages.length).toBe(1);
    });

    test("turn_end clears previous guidance after evaluation", async () => {
        resetSession("session-1");
        const { pi, handlers } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            {},
            pi,
        );
        setPendingGuidance("session-1", "previous guidance");

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("Still failing"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getPendingGuidance("session-1")).toContain("pass");
        expect(getPendingGuidance("session-1")).not.toContain("previous guidance");
    });

    test("mid-run toolUse turns accrue spend but never steer, evaluate, or count a run", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"] },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        // Three tool-call turns inside a single agent run.
        for (let i = 0; i < 3; i++) {
            for (const handler of turnHandlers) {
                await handler({
                    type: "turn_end",
                    turnIndex: i + 1,
                    message: makeToolUseMessage("running a command"),
                    toolResults: [],
                } as TurnEndEvent, ctx);
            }
        }

        const midRun = getGoal("session-1")!;
        expect(midRun.status).toBe("active");
        // The agent is already working — no "keep going" spam.
        expect(userMessages.length).toBe(0);
        expect(midRun.evaluations.length).toBe(0);
        // --max-turns budgets agent runs, not tool calls.
        expect(midRun.turnCount).toBe(0);
        // Spend still accrues across every LLM round-trip.
        expect(midRun.tokenSpend).toBe(45);

        // The run ends: now the loop runs exactly once.
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 4,
                message: makeAssistantMessage("Still failing"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        const afterRun = getGoal("session-1")!;
        expect(afterRun.turnCount).toBe(1);
        expect(afterRun.evaluations.length).toBe(1);
        expect(userMessages.length).toBe(1);
    });

    test("a mid-run tool loop still stops the goal when a token budget is exhausted", async () => {
        resetSession("session-1");
        const { pi, handlers, messages, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"] },
            { maxTokens: 30 },
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (let i = 0; i < 2; i++) {
            for (const handler of turnHandlers) {
                await handler({
                    type: "turn_end",
                    turnIndex: i + 1,
                    message: makeToolUseMessage("running a command"),
                    toolResults: [],
                } as TurnEndEvent, ctx);
            }
        }

        // A runaway tool loop can't spend past the budget just because it
        // never reaches a run boundary.
        expect(getGoal("session-1")?.status).toBe("failed");
        expect(getGoal("session-1")?.stopReason).toBe("max_tokens");
        expect(messages.some((m) => m.content.includes("budget reached"))).toBe(true);
        expect(userMessages.length).toBe(0);
    });

    test("throttles the LLM evaluator to every N runs while still looping and enforcing budgets", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "the deploy succeeds", evaluator: "llm", evaluateEveryNTurns: 3, minTurnsBeforeEvaluate: 0 },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        async function runTurn(text: string) {
            for (const handler of turnHandlers) {
                await handler({
                    type: "turn_end",
                    turnIndex: 1,
                    message: makeAssistantMessage(text),
                    toolResults: [],
                } as TurnEndEvent, ctx);
            }
        }

        // No configured evaluator model in the fake ctx, so every evaluation
        // that does run resolves to "uncertain" (not "not_met") — this test
        // only cares how many runs actually invoke the evaluator.
        await runTurn("working on it"); // run 1: first eligible run always evaluates
        expect(getGoal("session-1")?.evaluations.length).toBe(1);

        await runTurn("still working"); // run 2: throttled, skips evaluation
        expect(getGoal("session-1")?.evaluations.length).toBe(1);
        // The loop still continues even though the evaluator didn't run.
        expect(userMessages.length).toBe(1);

        await runTurn("still working"); // run 3: still throttled
        expect(getGoal("session-1")?.evaluations.length).toBe(1);

        // Cadence is measured from the last evaluation (run 1), not
        // `turnCount % rate`, so the next evaluation lands on run 4.
        await runTurn("still working"); // run 4: 3 runs since last eval
        expect(getGoal("session-1")?.evaluations.length).toBe(2);

        expect(getGoal("session-1")?.turnCount).toBe(4);
        expect(getGoal("session-1")?.status).toBe("active");
    });

    test("evaluates at the first run boundary by default", async () => {
        resetSession("session-1");
        const { pi, handlers } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        // No --min-turns: the default is one completed agent run, which is
        // already a substantial chunk of work.
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"] },
            {},
            pi,
        );

        for (const handler of handlers.get("turn_end") ?? []) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("All tests pass"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.evaluations.length).toBe(1);
        expect(getGoal("session-1")?.status).toBe("met");
    });

    test("defers evaluation until --min-turns runs have completed", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 3 },
            {},
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (let i = 0; i < 2; i++) {
            for (const handler of turnHandlers) {
                await handler({
                    type: "turn_end",
                    turnIndex: i + 1,
                    message: makeAssistantMessage("All tests pass"),
                    toolResults: [],
                } as TurnEndEvent, ctx);
            }
        }

        // The keyword is present, but the evaluator hasn't been allowed to run.
        expect(getGoal("session-1")?.status).toBe("active");
        expect(getGoal("session-1")?.turnCount).toBe(2);
        expect(getGoal("session-1")?.evaluations.length).toBe(0);
        expect(userMessages.length).toBe(2);

        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 3,
                message: makeAssistantMessage("All tests pass"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("met");
        expect(getGoal("session-1")?.turnCount).toBe(3);
        expect(getGoal("session-1")?.evaluations.length).toBe(1);
        expect(userMessages.length).toBe(2);
    });

    test("an uncertain verdict does not auto-continue the loop", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        // No authenticated evaluator model → every evaluation is "uncertain".
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal("session-1", { description: "the deploy succeeds", evaluator: "llm" }, {}, pi);

        for (const handler of handlers.get("turn_end") ?? []) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("working on it"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.evaluations.at(-1)?.verdict).toBe("uncertain");
        // A broken evaluator must not spin the session forever.
        expect(userMessages.length).toBe(0);
    });

    test("throttled turns still stop the goal when a budget is exhausted", async () => {
        const { pi, handlers, messages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "the deploy succeeds", evaluator: "llm", evaluateEveryNTurns: 5, minTurnsBeforeEvaluate: 0 },
            { maxTurns: 2 },
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("turn 1"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }
        // Turn 2 is throttled (rate 5) but still hits the maxTurns: 2 budget.
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("turn 2"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("failed");
        expect(getGoal("session-1")?.stopReason).toBe("max_turns");
        expect(messages.some((m) => m.content.includes("budget reached"))).toBe(true);
    });

    test("guidance rides the steer message only — no system-prompt injection", async () => {
        resetSession("session-1");
        const { pi, handlers, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        // The extension must not register before_agent_start: guidance used to
        // be delivered on both channels, repeating every turn and never
        // clearing from the system prompt.
        expect(handlers.get("before_agent_start")).toBeUndefined();

        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"] },
            {},
            pi,
        );
        setPendingGuidance("session-1", "add more tests");

        for (const handler of handlers.get("turn_end") ?? []) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("Still failing"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(userMessages.length).toBe(1);
        expect(userMessages[0]!.content).toContain("Goal not met");
    });

    test("goal met on the final budgeted turn reports met, not budget reached", async () => {
        resetSession("session-1");
        const { pi, handlers, messages, userMessages } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"], minTurnsBeforeEvaluate: 0 },
            { maxTurns: 1 },
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("All tests pass"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        expect(getGoal("session-1")?.status).toBe("met");
        expect(getGoal("session-1")?.stopReason).toBe("goal_met");
        expect(messages.some((m) => m.content.includes("Goal met"))).toBe(true);
        expect(messages.some((m) => m.content.includes("budget reached"))).toBe(false);
        expect(userMessages.length).toBe(0);
    });

    test("turn_end budget exhaustion warns, stops the loop, and does not stop session", async () => {
        resetSession("session-1");
        const { pi, handlers, messages, userMessages } = createFakePi();
        let shutdownCalled = false;
        const ctx = createFakeCtx({ shutdown: () => { shutdownCalled = true; } });

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "x", evaluator: "keyword", minTurnsBeforeEvaluate: 0 },
            { maxTurns: 2 },
            pi,
        );

        const turnHandlers = handlers.get("turn_end") ?? [];
        for (let i = 0; i < 2; i++) {
            for (const handler of turnHandlers) {
                await handler({
                    type: "turn_end",
                    turnIndex: i + 1,
                    message: makeAssistantMessage("working"),
                    toolResults: [],
                } as TurnEndEvent, ctx);
            }
        }

        expect(getGoal("session-1")?.status).toBe("failed");
        expect(getGoal("session-1")?.stopReason).toBe("max_turns");
        expect(shutdownCalled).toBe(false);
        expect(messages.some((m) => m.content.includes("budget reached"))).toBe(true);
        // Turn 1 auto-continued (not met); turn 2 hit the budget — no continuation.
        expect(userMessages.length).toBe(1);
    });

    test("broadcasts active goal status on set, update, and clear", async () => {
        resetSession("session-1");
        const { pi, handlers, events, commands } = createFakePi();
        const ctx = createFakeCtx();

        goalExtension(pi);

        // /goal command sets an active goal and broadcasts it.
        const goalHandler = commands.get("goal");
        expect(goalHandler).toBeDefined();
        await goalHandler!("tests pass --max-turns 5 --evaluator keyword --keyword pass --min-turns 1", ctx as ExtensionCommandContext);

        let emitted = events.get("goal:state_changed") ?? [];
        expect(emitted.length).toBe(1);
        expect((emitted[0] as any).status).toBe("active");
        expect((emitted[0] as any).description).toBe("tests pass");
        expect((emitted[0] as any).maxTurns).toBe(5);

        // turn_end not met broadcasts an updated turn count / reason.
        const turnHandlers = handlers.get("turn_end") ?? [];
        for (const handler of turnHandlers) {
            await handler({
                type: "turn_end",
                turnIndex: 1,
                message: makeAssistantMessage("Still failing"),
                toolResults: [],
            } as TurnEndEvent, ctx);
        }

        emitted = events.get("goal:state_changed") ?? [];
        expect(emitted.length).toBe(2);
        expect((emitted[1] as any).turnCount).toBe(1);
        expect((emitted[1] as any).lastReason).toContain("pass");

        // /goal clear broadcasts null.
        await goalHandler!("clear", ctx as ExtensionCommandContext);

        emitted = events.get("goal:state_changed") ?? [];
        expect(emitted.length).toBe(3);
        expect(emitted[2]).toBeNull();
    });

    test("restores active goal from persisted entries on session_start", async () => {
        resetSession("session-1");
        const { pi, handlers, events } = createFakePi();
        const persisted = {
            version: 1 as const,
            id: "goal_123",
            condition: { description: "foo", evaluator: "keyword" as const },
            budget: { maxTurns: 5 },
            status: "active" as const,
            turnCount: 2,
            tokenSpend: 100,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };
        const ctx = createFakeCtx({
            entries: [
                { type: "custom", customType: "goal_state", data: persisted },
            ] as SessionEntry[],
        });

        goalExtension(pi);

        const startHandlers = handlers.get("session_start") ?? [];
        for (const handler of startHandlers) {
            await handler({ type: "session_start" }, ctx);
        }

        expect(getGoal("session-1")?.id).toBe("goal_123");
        const emitted = events.get("goal:state_changed") ?? [];
        expect(emitted.length).toBe(1);
        expect((emitted[0] as any).status).toBe("active");
        expect((emitted[0] as any).turnCount).toBe(2);
    });

    test("getSessionId prefers sessionManager over environment variables", async () => {
        resetSession("manager-session");
        resetSession("env-session");
        const { pi, commands } = createFakePi();
        const originalEnv = process.env.PIZZAPI_SESSION_ID;
        process.env.PIZZAPI_SESSION_ID = "env-session";

        const ctx = {
            cwd: "/tmp/pizzapi-goal-test",
            sessionManager: { getSessionId: () => "manager-session", getEntries: () => [] },
            modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false },
            shutdown: () => {},
            ui: { setStatus: () => {} },
        } as unknown as ExtensionCommandContext;

        goalExtension(pi);
        const goalHandler = commands.get("goal")!;
        await goalHandler("tests pass --evaluator keyword --keyword pass", ctx);

        expect(getGoal("manager-session")?.condition.description).toBe("tests pass");
        expect(getGoal("env-session")).toBeUndefined();

        if (originalEnv === undefined) {
            delete process.env.PIZZAPI_SESSION_ID;
        } else {
            process.env.PIZZAPI_SESSION_ID = originalEnv;
        }
    });
});
