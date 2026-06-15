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
import { keywordGoalEvaluator, parseLlmVerdict, createLlmGoalEvaluator } from "./evaluator.js";
import { extractLatestTurnText, buildTranscript, extractAgentMessageText } from "./transcript.js";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import type { GoalState, GoalVerdict } from "./types.js";
import type {
    ExtensionAPI,
    ExtensionContext,
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

    test("returns uncertain for ambiguous responses", () => {
        expect(parseLlmVerdict("maybe later").verdict).toBe("uncertain");
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
    entries: Array<{ customType: string; data: unknown }>;
} {
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];

    const pi = {
        on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        sendMessage: (msg: { customType: string; content: string; display: boolean }) => {
            messages.push(msg);
        },
        appendEntry: (customType: string, data?: unknown) => {
            entries.push({ customType, data });
        },
        registerCommand: () => {},
    } as unknown as ExtensionAPI;

    return { pi, handlers, messages, entries };
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

    test("turn_end keyword goal met stops session", async () => {
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
        expect(shutdownCalled).toBe(true);
        expect(messages.some((m) => m.content.includes("Goal met"))).toBe(true);
    });

    test("turn_end keyword not met stores guidance for next turn", async () => {
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
    });

    test("before_agent_start injects pending guidance into system prompt", async () => {
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
        expect(getPendingGuidance("session-1")).toBeUndefined();
    });

    test("turn_end budget exhaustion stops session", async () => {
        resetSession("session-1");
        const { pi, handlers, messages } = createFakePi();
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
        expect(shutdownCalled).toBe(true);
        expect(messages.some((m) => m.content.includes("budget reached"))).toBe(true);
    });
});
