/**
 * Integration tests for the `/goal` multi-turn feedback loop.
 *
 * These tests exercise the real extension wiring (`goalExtension`) across
 * several simulated turns. They verify:
 *
 *   - `/goal` sets an active goal and broadcasts it.
 *   - The evaluator marks the goal as not met when the condition is missing.
 *   - Evaluator guidance is injected into the next turn's system prompt.
 *   - The simulated agent acts (assistant text / tool result) and on the
 *     following turn the evaluator clears the goal and stops the session.
 *
 * The tests are environment-independent: they use temp directories for the
 * project cwd and global config dir, and the LLM evaluator path mocks the
 * network call via `mock.module` so no real API requests are made.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    SessionEntry,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { _setGlobalConfigDir } from "../../config/io.js";
import { goalExtension } from "./index.js";
import { getGoal, getPendingGuidance, resetSession } from "./state.js";

// ── Mock the network path for the LLM evaluator ──────────────────────────────

const fakeCompleteSimple = mock(async (_model: unknown, context: { messages: Array<{ content: unknown }> }): Promise<AssistantMessage> => {
    const prompt = typeof context.messages[0]?.content === "string" ? context.messages[0].content : "";
    const wantsMet = prompt.includes("services are green") || prompt.includes("all tests pass");
    return {
        role: "assistant",
        content: [
            {
                type: "text",
                text: wantsMet
                    ? "Decision: yes\nReason: condition satisfied"
                    : "Decision: no\nReason: condition not yet satisfied",
            },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
    };
});

mock.module("@earendil-works/pi-ai", () => ({
    completeSimple: fakeCompleteSimple,
}));

// ── Test helpers ───────────────────────────────────────────────────────────

interface FakePi {
    pi: ExtensionAPI;
    handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
    messages: Array<{ customType: string; content: string; display: boolean }>;
    entries: Array<{ customType: string; data: unknown }>;
    events: Map<string, unknown[]>;
    commands: Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>;
}

function createFakePi(): FakePi {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];
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

    return { pi, handlers, messages, entries, events, commands };
}

function createFakeCtx(overrides: {
    cwd?: string;
    entries?: SessionEntry[];
    shutdown?: () => void;
    signal?: AbortSignal;
} = {}): ExtensionContext {
    return {
        cwd: overrides.cwd ?? "/tmp/pizzapi-goal-integration-test",
        sessionManager: {
            getSessionId: () => process.env.PIZZAPI_SESSION_ID ?? "session-test",
            getEntries: () => overrides.entries ?? [],
        },
        modelRegistry: {
            getAll: () => [{ provider: "anthropic", id: "claude-haiku-4-5" }],
            hasConfiguredAuth: () => true,
            getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "fake-api-key", headers: {} }),
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
        model: "claude-haiku-4-5",
        usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function makeToolResult(text: string): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
    };
}

async function runBeforeAgentStart(handlers: FakePi["handlers"], ctx: ExtensionContext, basePrompt = "base prompt"): Promise<string> {
    let systemPrompt = basePrompt;
    for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = (await handler(
            {
                type: "before_agent_start",
                prompt: "continue",
                systemPrompt,
                systemPromptOptions: {} as any,
            } as BeforeAgentStartEvent,
            ctx,
        )) as { systemPrompt?: string } | undefined;
        if (result?.systemPrompt) {
            systemPrompt = result.systemPrompt;
        }
    }
    return systemPrompt;
}

async function runTurnEnd(
    handlers: FakePi["handlers"],
    ctx: ExtensionContext,
    turnIndex: number,
    assistantText: string,
    toolResults: ToolResultMessage[] = [],
): Promise<void> {
    for (const handler of handlers.get("turn_end") ?? []) {
        await handler(
            {
                type: "turn_end",
                turnIndex,
                message: makeAssistantMessage(assistantText),
                toolResults,
            } as TurnEndEvent,
            ctx,
        );
    }
}

// ── Test harness setup ───────────────────────────────────────────────────────

describe("/goal multi-turn integration", () => {
    let originalSessionId: string | undefined;
    let originalHome: string | undefined;
    let tmpHome: string;
    let tmpCwd: string;

    beforeEach(() => {
        originalSessionId = process.env.PIZZAPI_SESSION_ID;
        process.env.PIZZAPI_SESSION_ID = "goal-integration-session";

        originalHome = process.env.HOME;
        tmpHome = mkdtempSync(join(tmpdir(), "pizzapi-goal-global-"));
        tmpCwd = mkdtempSync(join(tmpdir(), "pizzapi-goal-project-"));
        process.env.HOME = tmpHome;
        _setGlobalConfigDir(tmpHome);

        resetSession("goal-integration-session");
        fakeCompleteSimple.mockClear();
    });

    afterEach(() => {
        if (originalSessionId === undefined) {
            delete process.env.PIZZAPI_SESSION_ID;
        } else {
            process.env.PIZZAPI_SESSION_ID = originalSessionId;
        }

        process.env.HOME = originalHome;
        _setGlobalConfigDir(null);
        resetSession("goal-integration-session");
        fakeCompleteSimple.mockClear();
    });

    afterAll(() => {
        mock.restore();
    });

    test("keyword evaluator loop: unmet → guidance → agent acts → goal cleared", async () => {
        const { pi, handlers, messages, entries, events, commands } = createFakePi();
        const shutdown = mock(() => {});
        const ctx = createFakeCtx({ cwd: tmpCwd, shutdown: shutdown as unknown as () => void });

        goalExtension(pi);

        // User sets a goal via /goal.
        const goalHandler = commands.get("goal")!;
        await goalHandler(
            '"tests pass" --evaluator keyword --keyword "tests pass" --max-turns 5',
            ctx as ExtensionCommandContext,
        );

        expect(getGoal("goal-integration-session")?.condition.description).toBe("tests pass");
        expect(messages.some((m) => m.content.includes("Goal set"))).toBe(true);
        expect((events.get("goal:state_changed") ?? []).length).toBe(1);

        // Turn 1: agent has not satisfied the condition yet.
        let systemPrompt = await runBeforeAgentStart(handlers, ctx, "You are a helpful assistant.");
        expect(systemPrompt).not.toContain("[Goal guidance]");

        await runTurnEnd(handlers, ctx, 1, "I am going to run the test suite now.");

        const stateAfterTurn1 = getGoal("goal-integration-session")!;
        expect(stateAfterTurn1.status).toBe("active");
        expect(stateAfterTurn1.turnCount).toBe(1);
        expect(getPendingGuidance("goal-integration-session")).toContain("tests pass");
        expect(shutdown).not.toHaveBeenCalled();

        // Turn 2: guidance is injected before the agent starts. Guidance is kept
        // in memory until the next turn_end evaluation runs, so it is still
        // pending here.
        systemPrompt = await runBeforeAgentStart(handlers, ctx, "You are a helpful assistant.");
        expect(systemPrompt).toContain("[Goal guidance]");
        expect(systemPrompt).toContain("tests pass");
        expect(getPendingGuidance("goal-integration-session")).toContain("tests pass");

        // Agent acts and reports the success keyword (via tool result text).
        await runTurnEnd(handlers, ctx, 2, "The test run finished.", [makeToolResult("All tests pass")]);

        // After turn_end evaluation the previous guidance is cleared (and no new
        // guidance is set because the goal was met).
        expect(getPendingGuidance("goal-integration-session")).toBeUndefined();

        const finalState = getGoal("goal-integration-session")!;
        expect(finalState.status).toBe("met");
        expect(finalState.stopReason).toBe("goal_met");
        expect(finalState.turnCount).toBe(2);
        expect(shutdown).not.toHaveBeenCalled();
        expect(messages.some((m) => m.content.includes("Goal met"))).toBe(true);

        // Each state change was broadcast (set, update after turn 1, clear after met).
        const broadcasts = events.get("goal:state_changed") ?? [];
        expect(broadcasts.length).toBe(3);
        expect(broadcasts[2]).toBeNull();

        // Persisted goal_state entries were written on set + each evaluation.
        expect(entries.filter((e) => e.customType === "goal_state").length).toBeGreaterThanOrEqual(3);
    });

    test("LLM evaluator loop: unmet → guidance → agent acts → goal cleared (mocked network)", async () => {
        const { pi, handlers, messages, events, commands } = createFakePi();
        const shutdown = mock(() => {});
        const ctx = createFakeCtx({ cwd: tmpCwd, shutdown: shutdown as unknown as () => void });

        goalExtension(pi);

        // User sets a goal that uses the default LLM evaluator.
        const goalHandler = commands.get("goal")!;
        await goalHandler('"services are green" --max-turns 5', ctx as ExtensionCommandContext);

        expect(getGoal("goal-integration-session")?.condition.evaluator).toBe("llm");
        expect(messages.some((m) => m.content.includes("Goal set"))).toBe(true);

        // Program the mocked evaluator to say "not met" on turn 1 and "met" on turn 2.
        fakeCompleteSimple.mockImplementationOnce(async () => ({
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Decision: no\nReason: services still starting" }],
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: "claude-haiku-4-5",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop" as const,
            timestamp: Date.now(),
        }));
        fakeCompleteSimple.mockImplementationOnce(async () => ({
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Decision: yes\nReason: services are green" }],
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: "claude-haiku-4-5",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop" as const,
            timestamp: Date.now(),
        }));

        // Turn 1: evaluator says not met and stores guidance.
        await runTurnEnd(handlers, ctx, 1, "I am checking service health.");

        expect(fakeCompleteSimple).toHaveBeenCalledTimes(1);
        const firstPrompt = (fakeCompleteSimple.mock.calls[0][1] as { messages: Array<{ content: unknown }> }).messages[0]?.content;
        expect(typeof firstPrompt).toBe("string");
        expect(firstPrompt as string).toContain("services are green");

        const stateAfterTurn1 = getGoal("goal-integration-session")!;
        expect(stateAfterTurn1.status).toBe("active");
        expect(stateAfterTurn1.turnCount).toBe(1);
        expect(getPendingGuidance("goal-integration-session")).toContain("services still starting");
        expect(shutdown).not.toHaveBeenCalled();

        // Turn 2: guidance is injected; agent acts and satisfies the LLM condition.
        const systemPrompt = await runBeforeAgentStart(handlers, ctx, "You are a helpful assistant.");
        expect(systemPrompt).toContain("[Goal guidance]");
        expect(systemPrompt).toContain("services still starting");

        await runTurnEnd(handlers, ctx, 2, "Health check complete: services are green.");

        expect(fakeCompleteSimple).toHaveBeenCalledTimes(2);
        const secondPrompt = (fakeCompleteSimple.mock.calls[1][1] as { messages: Array<{ content: unknown }> }).messages[0]?.content;
        expect(secondPrompt as string).toContain("Goal: services are green");
        expect(secondPrompt as string).toContain("Latest turn:");

        const finalState = getGoal("goal-integration-session")!;
        expect(finalState.status).toBe("met");
        expect(finalState.stopReason).toBe("goal_met");
        expect(finalState.turnCount).toBe(2);
        expect(shutdown).not.toHaveBeenCalled();
        expect(messages.some((m) => m.content.includes("Goal met"))).toBe(true);

        const broadcasts = events.get("goal:state_changed") ?? [];
        expect(broadcasts.length).toBe(3);
        expect(broadcasts[2]).toBeNull();
    });

    test("goal is not cleared until the condition is actually met", async () => {
        const { pi, handlers, messages, commands } = createFakePi();
        const shutdown = mock(() => {});
        const ctx = createFakeCtx({ cwd: tmpCwd, shutdown: shutdown as unknown as () => void });

        goalExtension(pi);

        const goalHandler = commands.get("goal")!;
        await goalHandler(
            '"build succeeded" --evaluator keyword --keyword "build succeeded" --max-turns 4',
            ctx as ExtensionCommandContext,
        );

        // Two turns where the condition is still missing.
        await runTurnEnd(handlers, ctx, 1, "I am reading the build script.");
        await runTurnEnd(handlers, ctx, 2, "The script looks okay but I have not run it yet.");

        const state = getGoal("goal-integration-session")!;
        expect(state.status).toBe("active");
        expect(state.turnCount).toBe(2);
        expect(shutdown).not.toHaveBeenCalled();
        expect(messages.filter((m) => m.content.includes("Goal met")).length).toBe(0);
    });
});
