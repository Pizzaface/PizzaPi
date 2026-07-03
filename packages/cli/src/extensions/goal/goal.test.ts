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
    recordEvaluation,
    recordTurnSpend,
    resetSession,
    restoreGoal,
    setGoal,
    setPendingGuidance,
} from "./state.js";
import { keywordGoalEvaluator, parseLlmVerdict, createLlmGoalEvaluator, resolveEvaluatorModel } from "./evaluator.js";
import { extractLatestTurnText, buildTranscript, extractAgentMessageText } from "./transcript.js";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import type { GoalState, GoalVerdict } from "./types.js";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ModelRegistry,
    TurnEndEvent,
    BeforeAgentStartEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { goalExtension } from "./index.js";

function fakeAppendEntry(_customType: string, _data: unknown): void {
    /* no-op for tests */
}

function makeGoal(): GoalState {
    return setGoal(
        "session-1",
        { description: "the tests pass", evaluator: "keyword", successKeywords: ["tests pass"] },
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

    test("rejects unknown flags", () => {
        expect(() => parseGoalArgs("foo --unknown bar")).toThrow("Unknown flag: --unknown");
    });

    test("rejects missing condition", () => {
        expect(() => parseGoalArgs("--max-turns 5")).toThrow("A goal condition is required");
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

    test("recordTurnSpend increments counters", () => {
        resetSession("session-1");
        makeGoal();
        const updated = recordTurnSpend("session-1", 123, 0.001);
        expect(updated?.turnCount).toBe(1);
        expect(updated?.tokenSpend).toBe(123);
        expect(updated?.costSpend).toBe(0.001);
    });

    test("keyword evaluator marks goal met", async () => {
        resetSession("session-1");
        makeGoal();
        recordTurnSpend("session-1", 10, 0);
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
        recordTurnSpend("session-1", 1, 0);
        recordTurnSpend("session-1", 1, 0);
        const state = recordTurnSpend("session-1", 1, 0);
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
            { description: "old", evaluator: "keyword", successKeywords: ["done"] },
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
            { description: "new", evaluator: "keyword", successKeywords: ["done"] },
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
        signal: overrides.signal ?? undefined,
        shutdown: overrides.shutdown ?? (() => {}),
        ui: {
            setStatus: (_key: string, _text?: string) => {},
        },
    } as unknown as ExtensionContext;
}

function makeAssistantMessage(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "haiku",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
        stopReason: "stop",
        timestamp: Date.now(),
    };
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
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"] },
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

    test("turn_end keyword not met stores guidance and auto-continues the loop", async () => {
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
        // The goal loop keeps working: a not_met verdict triggers a follow-up turn.
        expect(userMessages.length).toBe(1);
        expect(userMessages[0]!.content).toContain("Goal not met");
        expect(userMessages[0]!.content).toContain("tests pass");
        expect(userMessages[0]!.options?.deliverAs).toBe("followUp");
    });

    test("turn_end goal met does not auto-continue", async () => {
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
            { description: "tests pass", evaluator: "keyword", successKeywords: ["pass"] },
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

    test("before_agent_start injects pending guidance into system prompt without clearing it", async () => {
        resetSession("session-1");
        setPendingGuidance("session-1", "add more tests");

        const { pi, handlers } = createFakePi();
        goalExtension(pi);
        const ctx = createFakeCtx();

        const beforeHandlers = handlers.get("before_agent_start") ?? [];
        let result: { systemPrompt?: string } | undefined;
        for (const handler of beforeHandlers) {
            result = (await handler({
                type: "before_agent_start",
                prompt: "continue",
                systemPrompt: "base prompt",
                systemPromptOptions: {} as any,
            } as BeforeAgentStartEvent, ctx)) as typeof result;
        }

        expect(result?.systemPrompt).toContain("[Goal guidance]");
        expect(result?.systemPrompt).toContain("add more tests");
        expect(getPendingGuidance("session-1")).toBe("add more tests");
    });

    test("turn_end budget exhaustion warns, stops the loop, and does not stop session", async () => {
        resetSession("session-1");
        const { pi, handlers, messages, userMessages } = createFakePi();
        let shutdownCalled = false;
        const ctx = createFakeCtx({ shutdown: () => { shutdownCalled = true; } });

        goalExtension(pi);
        setGoal(
            "session-1",
            { description: "x", evaluator: "keyword" },
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
        await goalHandler!("tests pass --max-turns 5 --evaluator keyword --keyword pass", ctx as ExtensionCommandContext);

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
