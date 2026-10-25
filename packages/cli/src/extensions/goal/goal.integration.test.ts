/**
 * Integration tests for the `/goal` multi-turn feedback loop.
 *
 * These tests exercise the real extension wiring (`goalExtension`) across
 * several simulated agent runs. They verify:
 *
 *   - `/goal` sets an active goal and broadcasts it.
 *   - The evaluator marks the goal as not met when the condition is missing.
 *   - Evaluator guidance is carried into the next run's steer message.
 *   - The simulated agent acts (assistant text / tool result) and on the
 *     following run the evaluator marks the goal met without stopping the
 *     session.
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
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    SessionEntry,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { _setGlobalConfigDir } from "../../config/io.js";
import { goalExtension } from "./index.js";
import { getGoal, getPendingGuidance, resetSession, formatGoalStatus, toMetaGoalStatus } from "./state.js";
import { parseLlmVerdict } from "./evaluator.js";
import { isCacheReuseViable, resetSessionContext } from "./session-context.js";

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

mock.module("@earendil-works/pi-ai/compat", () => ({
    completeSimple: fakeCompleteSimple,
}));

// ── Test helpers ───────────────────────────────────────────────────────────

interface FakePi {
    pi: ExtensionAPI;
    handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
    messages: Array<{ customType: string; content: string; display: boolean }>;
    userMessages: Array<{ content: string; options?: { deliverAs?: string } }>;
    entries: Array<{ customType: string; data: unknown }>;
    events: Map<string, unknown[]>;
    commands: Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>;
    tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
}

function createFakePi(): FakePi {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];
    const userMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    const events = new Map<string, unknown[]>();
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();

    const tools: FakePi["tools"] = new Map();
    const pi = {
        registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool),
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
            entries.push({ customType, data: structuredClone(data) });
        },
        registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) => {
            commands.set(name, options.handler);
        },
        // Tool introspection used to rebuild the tools block for cache reuse.
        getActiveTools: () => ["bash"],
        getAllTools: () => [
            { name: "bash", description: "run a command", parameters: { type: "object" }, sourceInfo: {} },
            { name: "unused", description: "not active", parameters: { type: "object" }, sourceInfo: {} },
        ],
        events: {
            emit: (event: string, payload: unknown) => {
                const list = events.get(event) ?? [];
                list.push(payload);
                events.set(event, list);
            },
        },
    } as unknown as ExtensionAPI;

    return { pi, handlers, messages, userMessages, entries, events, commands, tools };
}

function createFakeCtx(overrides: {
    cwd?: string;
    entries?: SessionEntry[];
    shutdown?: () => void;
    signal?: AbortSignal;
    model?: unknown;
} = {}): ExtensionContext {
    return {
        cwd: overrides.cwd ?? "/tmp/pizzapi-goal-integration-test",
        getSystemPrompt: () => "session system prompt",
        sessionManager: {
            getSessionId: () => process.env.PIZZAPI_SESSION_ID ?? "session-test",
            getEntries: () => overrides.entries ?? [],
        },
        modelRegistry: {
            getAll: () => [{
                provider: "anthropic",
                id: "claude-haiku-4-5",
                name: "Claude Haiku 4.5",
                api: "anthropic-messages",
                baseUrl: "",
                reasoning: false,
                input: ["text"],
                cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 4096,
            }],
            hasConfiguredAuth: () => true,
            getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "fake-api-key", headers: {} }),
        },
        model: overrides.model,
        signal: overrides.signal ?? undefined,
        shutdown: overrides.shutdown ?? (() => {}),
        ui: {
            setStatus: (_key: string, _text?: string) => {},
        },
        hasPendingMessages: () => false,
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

/**
 * Simulate a run-ending turn (`stopReason: "stop"`) — the agent has finished
 * and control is returning to the user. This is the only boundary where the
 * goal loop acts.
 */
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
        resetSessionContext("goal-integration-session");
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
        resetSessionContext("goal-integration-session");
        fakeCompleteSimple.mockClear();
    });

    afterAll(() => {
        mock.restore();
    });

    test.each([1, 10])("explicit waiting suppresses continuation even with --min-turns %i, then wakes on delivered input", async (minTurns) => {
        const { pi, handlers, commands, tools, userMessages } = createFakePi();
        const ctx = createFakeCtx({ cwd: tmpCwd });
        goalExtension(pi);
        await commands.get("goal")!(`tests pass --evaluator keyword --keyword SUCCESS --min-turns ${minTurns}`, ctx as ExtensionCommandContext);
        // Seed the persisted wait shape so this regression drives the original
        // continuation path before the new tool exists.
        Object.assign(getGoal("goal-integration-session")!, {
            waiting: { reason: "CI is running", wakeOn: "CI completion trigger" },
        });
        await runTurnEnd(handlers, ctx, 1, "Waiting for CI");
        await runTurnEnd(handlers, ctx, 2, "Still waiting for CI");
        expect(userMessages).toHaveLength(1); // kickoff only, no goal nudges
        expect(getGoal("goal-integration-session")?.evaluations).toHaveLength(0);
        expect(tools.has("goal_wait")).toBe(true);

        for (const handler of handlers.get("message_start") ?? []) {
            await handler({ message: { role: "custom", customType: "trigger", content: "CI finished" } }, ctx);
        }
        expect(getGoal("goal-integration-session")?.waiting).toBeUndefined();
        await runTurnEnd(handlers, ctx, 3, "More work remains");
        expect(userMessages).toHaveLength(2); // useful work can continue again
    });

    test("goal_wait survives reload, ignores tool/status messages, and manual resume preserves the goal and budget", async () => {
        const fake = createFakePi();
        const ctx = createFakeCtx({ cwd: tmpCwd });
        goalExtension(fake.pi);
        const command = fake.commands.get("goal")!;
        await command("CI succeeds --max-turns 8 --every 5", ctx as ExtensionCommandContext);
        const state = getGoal("goal-integration-session")!;
        state.lastEvaluatedTurn = 0; // within --every cadence
        await fake.tools.get("goal_wait")!.execute("wait", { reason: "CI running", wakeOn: "CI trigger" }, undefined, undefined, ctx);
        expect(formatGoalStatus(state)).toContain("Status: waiting");
        expect(toMetaGoalStatus(state).waiting).toEqual({ reason: "CI running", wakeOn: "CI trigger" });
        for (const message of [makeToolResult("wait registered"), { role: "custom", customType: "goal_status" }]) {
            for (const handler of fake.handlers.get("message_start") ?? []) await handler({ message }, ctx);
        }
        await runTurnEnd(fake.handlers, ctx, 1, "Waiting");
        expect(fake.userMessages).toHaveLength(1);
        expect(fakeCompleteSimple).not.toHaveBeenCalled();
        const saved = structuredClone(fake.entries).map((entry) => ({ ...entry, type: "custom" })) as SessionEntry[];
        for (const handler of fake.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
        for (const handler of fake.handlers.get("session_start") ?? []) await handler({}, createFakeCtx({ entries: saved }));
        expect(getGoal("goal-integration-session")?.waiting?.wakeOn).toBe("CI trigger");
        expect(getGoal("goal-integration-session")?.turnCount).toBe(1);
        await command("resume", ctx as ExtensionCommandContext);
        expect(fake.userMessages).toHaveLength(2);
        expect(getGoal("goal-integration-session")?.waiting).toBeUndefined();
        expect(getGoal("goal-integration-session")?.id).toBe(state.id);
        expect(getGoal("goal-integration-session")?.budget.maxTurns).toBe(8);
        expect(getGoal("goal-integration-session")?.tokenSpend).toBe(15);
        await command("resume", ctx as ExtensionCommandContext);
        expect(fake.userMessages).toHaveLength(2); // no double resume
        await command("clear", ctx as ExtensionCommandContext);
        await expect(fake.tools.get("goal_wait")!.execute("wait", { reason: "x", wakeOn: "y" }, undefined, undefined, ctx)).rejects.toThrow("No active goal");
    });

    test("/goal pause is sticky across messages and goal_wait until explicit resume", async () => {
        const fake = createFakePi();
        const ctx = createFakeCtx({ cwd: tmpCwd });
        goalExtension(fake.pi);
        const command = fake.commands.get("goal")!;
        await command("CI succeeds --max-turns 8", ctx as ExtensionCommandContext);
        const id = getGoal("goal-integration-session")!.id;
        await command("pause", ctx as ExtensionCommandContext);
        expect(getGoal("goal-integration-session")?.waiting?.manual).toBe(true);
        expect(formatGoalStatus(getGoal("goal-integration-session")!)).toContain("Status: paused");
        for (const message of [{ role: "user", content: "Other request" }, { role: "custom", customType: "trigger", content: "Unrelated event" }]) {
            for (const handler of fake.handlers.get("message_start") ?? []) await handler({ message }, ctx);
        }
        await fake.tools.get("goal_wait")!.execute("wait", { reason: "CI running", wakeOn: "CI result" }, undefined, undefined, ctx);
        expect(getGoal("goal-integration-session")?.waiting?.manual).toBe(true);
        await runTurnEnd(fake.handlers, ctx, 1, "Answered unrelated request");
        expect(fake.userMessages).toHaveLength(1);
        expect(fakeCompleteSimple).not.toHaveBeenCalled();
        const saved = fake.entries.map((entry) => ({ ...entry, type: "custom" })) as SessionEntry[];
        for (const handler of fake.handlers.get("session_start") ?? []) await handler({}, createFakeCtx({ entries: saved }));
        expect(getGoal("goal-integration-session")?.waiting?.manual).toBe(true);
        await command("resume", ctx as ExtensionCommandContext);
        expect(getGoal("goal-integration-session")?.waiting).toBeUndefined();
        expect(getGoal("goal-integration-session")?.id).toBe(id);
        expect(getGoal("goal-integration-session")?.turnCount).toBe(1);
        expect(fake.userMessages).toHaveLength(2);
        await command("clear", ctx as ExtensionCommandContext);
        await command("pause", ctx as ExtensionCommandContext);
        expect(getGoal("goal-integration-session")?.status).toBe("cancelled");
        expect(fake.userMessages).toHaveLength(2);
    });

    test("waiting still enforces budgets and rejects blank wait reasons", async () => {
        const fake = createFakePi();
        const ctx = createFakeCtx({ cwd: tmpCwd });
        goalExtension(fake.pi);
        await fake.commands.get("goal")!("CI succeeds --max-turns 1", ctx as ExtensionCommandContext);
        await expect(fake.tools.get("goal_wait")!.execute("wait", { reason: " ", wakeOn: "CI" }, undefined, undefined, ctx)).rejects.toThrow("requires");
        await fake.tools.get("goal_wait")!.execute("wait", { reason: "CI running", wakeOn: "CI trigger" }, undefined, undefined, ctx);
        await runTurnEnd(fake.handlers, ctx, 1, "Waiting");
        expect(getGoal("goal-integration-session")?.stopReason).toBe("max_turns");
        expect(getGoal("goal-integration-session")?.waiting).toBeUndefined();
        expect(fake.userMessages).toHaveLength(1);
    });

    test.each([false, true])("LLM waiting verdict pauses the loop (cached=%s) and user input wakes it", async (cached) => {
        const fake = createFakePi();
        const ctx = createFakeCtx({ cwd: tmpCwd });
        goalExtension(fake.pi);
        await fake.commands.get("goal")!("CI succeeds", ctx as ExtensionCommandContext);
        if (cached) {
            ctx.model = ctx.modelRegistry.getAll()[0];
            for (const handler of fake.handlers.get("context") ?? []) {
                await handler({ messages: [{ role: "user", content: "CI succeeds", timestamp: Date.now() }] }, ctx);
            }
        }
        fakeCompleteSimple.mockImplementationOnce(async (_model, context) => {
            expect(JSON.stringify(context.messages.at(-1))).toContain('waiting');
            return { ...makeAssistantMessage(JSON.stringify({ verdict: "waiting", reason: "CI running", wakeOn: "CI trigger" })), usage: { ...makeAssistantMessage("").usage, cacheRead: 10 } };
        });
        await runTurnEnd(fake.handlers, ctx, 1, "Waiting for CI");
        expect(getGoal("goal-integration-session")?.waiting).toEqual({ reason: "CI running", wakeOn: "CI trigger" });
        expect(fake.userMessages).toHaveLength(1);
        await runTurnEnd(fake.handlers, ctx, 2, "Waiting for CI");
        expect(fakeCompleteSimple).toHaveBeenCalledTimes(1);
        for (const handler of fake.handlers.get("message_start") ?? []) await handler({ message: { role: "user", content: "CI finished" } }, ctx);
        expect(getGoal("goal-integration-session")?.waiting).toBeUndefined();
        fakeCompleteSimple.mockImplementationOnce(async () => makeAssistantMessage('{"verdict":"yes","reason":"CI passed"}'));
        await runTurnEnd(fake.handlers, ctx, 3, "CI passed");
        expect(getGoal("goal-integration-session")?.status).toBe("met");
        expect(fake.userMessages).toHaveLength(1);
    });

    test.each(["replace", "clear", "arrival", "pause", "pause-resume", "pause-budget"])("in-flight evaluator respects %s", async (action) => {
        const fake = createFakePi();
        const ctx = createFakeCtx({ cwd: tmpCwd });
        goalExtension(fake.pi);
        await fake.commands.get("goal")!(action === "pause-budget" ? "CI succeeds --max-cost 0.00015" : "CI succeeds", ctx as ExtensionCommandContext);
        const started = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        fakeCompleteSimple.mockImplementationOnce(async () => {
            started.resolve();
            await finished.promise;
            return makeAssistantMessage('{"verdict":"no","reason":"CI not finished"}');
        });
        const turn = runTurnEnd(fake.handlers, ctx, 1, "Waiting for CI");
        await started.promise;
        if (action === "arrival") ctx.hasPendingMessages = () => true;
        else if (action === "pause-resume") {
            await fake.commands.get("goal")!("pause", ctx as ExtensionCommandContext);
            await fake.commands.get("goal")!("resume", ctx as ExtensionCommandContext);
        } else await fake.commands.get("goal")!(action === "clear" ? "clear" : action === "pause" || action === "pause-budget" ? "pause" : "new objective", ctx as ExtensionCommandContext);
        finished.resolve();
        await turn;
        expect(fake.userMessages).toHaveLength(action === "replace" || action === "pause-resume" ? 2 : 1);
        if (action !== "arrival") expect(getGoal("goal-integration-session")?.evaluations).toHaveLength(0);
        if (action === "pause") expect(getGoal("goal-integration-session")?.waiting?.manual).toBe(true);
        expect(fake.entries.filter((entry) => entry.customType === "goal_evaluator_usage")).toHaveLength(1);
        if (action === "pause" || action === "pause-resume") {
            expect(getGoal("goal-integration-session")?.tokenSpend).toBe(30);
            expect(getGoal("goal-integration-session")?.costSpend).toBeCloseTo(0.0002);
        }
        if (action === "replace") expect(getGoal("goal-integration-session")?.tokenSpend).toBe(0);
        if (action === "pause-budget") {
            expect(getGoal("goal-integration-session")?.stopReason).toBe("max_cost");
            expect(getGoal("goal-integration-session")?.costSpend).toBeCloseTo(0.0002);
        }
        if (action === "arrival") {
            ctx.hasPendingMessages = () => false;
            await runTurnEnd(fake.handlers, ctx, 2, "More work remains");
            expect(fake.userMessages).toHaveLength(2);
        }
    });

    test("malformed waiting decisions never fall through to a keep-going verdict", () => {
        for (const verdict of [
            { verdict: "waiting", reason: "not met" },
            { verdict: "waiting", reason: "not met", wakeOn: " " },
            { verdict: "waiting", reason: "", wakeOn: "CI result" },
        ]) expect(parseLlmVerdict(JSON.stringify(verdict)).verdict).toBe("uncertain");
    });

    test("keyword evaluator loop: unmet → guidance → agent acts → goal cleared", async () => {
        const { pi, handlers, messages, entries, events, commands, userMessages } = createFakePi();
        const shutdown = mock(() => {});
        const ctx = createFakeCtx({ cwd: tmpCwd, shutdown: shutdown as unknown as () => void });

        goalExtension(pi);

        // User sets a goal via /goal.
        const goalHandler = commands.get("goal")!;
        await goalHandler(
            '"tests pass" --evaluator keyword --keyword "tests pass" --max-turns 5 --min-turns 1',
            ctx as ExtensionCommandContext,
        );

        expect(getGoal("goal-integration-session")?.condition.description).toBe("tests pass");
        expect(messages.some((m) => m.content.includes("Goal set"))).toBe(true);
        expect((events.get("goal:state_changed") ?? []).length).toBe(1);

        // Run 1: agent has not satisfied the condition yet.
        await runTurnEnd(handlers, ctx, 1, "I am going to run the test suite now.");

        const stateAfterTurn1 = getGoal("goal-integration-session")!;
        expect(stateAfterTurn1.status).toBe("active");
        expect(stateAfterTurn1.turnCount).toBe(1);
        expect(getPendingGuidance("goal-integration-session")).toContain("tests pass");
        expect(shutdown).not.toHaveBeenCalled();

        // The guidance rides the steer message that starts run 2 — one
        // channel, not a system-prompt injection that repeats every turn.
        expect(userMessages.at(-1)?.content).toContain("Goal not met");
        expect(userMessages.at(-1)?.options?.deliverAs).toBe("steer");
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
        const { pi, handlers, messages, events, commands, userMessages } = createFakePi();
        const shutdown = mock(() => {});
        // A distinctive session entry proves the standalone judge receives the
        // real transcript built from `getEntries()`, not just the goal text —
        // the fallback path's one source of session history.
        const ctx = createFakeCtx({
            cwd: tmpCwd,
            shutdown: shutdown as unknown as () => void,
            entries: [
                {
                    type: "message",
                    message: { role: "user", content: "please restart the payments worker", timestamp: 1 },
                    id: "1",
                    parentId: null,
                    timestamp: "1",
                } as unknown as SessionEntry,
            ],
        });

        goalExtension(pi);

        // User sets a goal that uses the default LLM evaluator. --every 1 is
        // the default cadence, stated explicitly here (see goal.test.ts for
        // dedicated throttling coverage) so this test exercises the
        // per-run evaluate -> guidance -> re-evaluate flow across exactly
        // the two runs below.
        const goalHandler = commands.get("goal")!;
        await goalHandler('"services are green" --max-turns 5 --every 1 --min-turns 1', ctx as ExtensionCommandContext);

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

        // Run 1: evaluator says not met and stores guidance.
        await runTurnEnd(handlers, ctx, 1, "I am checking service health.");

        expect(fakeCompleteSimple).toHaveBeenCalledTimes(1);
        const firstPrompt = (fakeCompleteSimple.mock.calls[0][1] as { messages: Array<{ content: unknown }> }).messages[0]?.content;
        expect(typeof firstPrompt).toBe("string");
        expect(firstPrompt as string).toContain("services are green");
        // The standalone judge is the one evaluator that needs the full
        // session transcript (the cache evaluator reuses the session's own
        // context instead). Prove `buildEvaluationContext` actually built it
        // from `ctx.sessionManager.getEntries()` and that it reached the
        // judge prompt, not just "(no transcript available)".
        expect(firstPrompt as string).toContain("Conversation so far:");
        expect(firstPrompt as string).toContain("User:\nplease restart the payments worker");

        const stateAfterTurn1 = getGoal("goal-integration-session")!;
        expect(stateAfterTurn1.status).toBe("active");
        expect(stateAfterTurn1.turnCount).toBe(1);
        expect(getPendingGuidance("goal-integration-session")).toContain("services still starting");
        expect(shutdown).not.toHaveBeenCalled();

        // Run 2 is kicked off by a steer message carrying the guidance; the
        // agent acts and satisfies the LLM condition.
        expect(userMessages.at(-1)?.content).toContain("services still starting");
        expect(userMessages.at(-1)?.options?.deliverAs).toBe("steer");

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

    test("evaluator reuses the session's cached context on the session's model", async () => {
        const { pi, handlers, commands } = createFakePi();
        const sessionModel = {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Sonnet",
            api: "anthropic-messages",
            baseUrl: "",
            reasoning: false,
            input: ["text"],
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            contextWindow: 200_000,
            maxTokens: 8192,
        };
        const ctx = createFakeCtx({ cwd: tmpCwd, model: sessionModel });

        goalExtension(pi);
        await commands.get("goal")!('"services are green" --min-turns 1', ctx as ExtensionCommandContext);

        // pi hands the extension the exact prefix it sends to the provider.
        const sessionMessages = [
            { role: "user" as const, content: "check the services", timestamp: 1 },
        ];
        for (const handler of handlers.get("context") ?? []) {
            const result = await handler({ type: "context", messages: sessionMessages } as never, ctx);
            // The capture hook must never modify the outgoing context.
            expect(result).toBeUndefined();
        }

        fakeCompleteSimple.mockImplementationOnce(async () => ({
            role: "assistant" as const,
            content: [{ type: "text" as const, text: '{"verdict": "no", "reason": "still starting"}' }],
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: { input: 40, output: 12, cacheRead: 4321, cacheWrite: 0, totalTokens: 4373, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
            stopReason: "stop" as const,
            timestamp: Date.now(),
        }));

        await runTurnEnd(handlers, ctx, 1, "I restarted the services.");

        expect(fakeCompleteSimple).toHaveBeenCalledTimes(1);
        const [model, context] = fakeCompleteSimple.mock.calls[0] as unknown as [
            { id: string },
            { systemPrompt?: string; tools?: unknown[]; messages: Array<{ role: string; content: unknown }> },
        ];

        // The session's own model, so the provider can serve the prefix from cache.
        expect(model.id).toBe("claude-sonnet-4-5");
        expect(context.systemPrompt).toBe("session system prompt");
        expect(context.messages[0]).toEqual(sessionMessages[0]);
        expect(context.messages).toHaveLength(2);
        expect(context.messages[1]!.role).toBe("user");

        // The cache read was non-zero, so the path stays enabled.
        expect(isCacheReuseViable("goal-integration-session")).toBe(true);
        expect(getGoal("goal-integration-session")?.evaluations.at(-1)?.verdict).toBe("not_met");
    });

    test("falls back to a standalone cheap-model call once the cache misses", async () => {
        const { pi, handlers, commands } = createFakePi();
        const sessionModel = {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Sonnet",
            api: "anthropic-messages",
            baseUrl: "",
            reasoning: false,
            input: ["text"],
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            contextWindow: 200_000,
            maxTokens: 8192,
        };
        const ctx = createFakeCtx({ cwd: tmpCwd, model: sessionModel });

        goalExtension(pi);
        await commands.get("goal")!('"services are green" --min-turns 1', ctx as ExtensionCommandContext);

        for (const handler of handlers.get("context") ?? []) {
            await handler({ type: "context", messages: [{ role: "user", content: "check", timestamp: 1 }] } as never, ctx);
        }

        // Run 1: the prefix didn't match, so nothing was served from cache.
        fakeCompleteSimple.mockImplementationOnce(async () => ({
            role: "assistant" as const,
            content: [{ type: "text" as const, text: '{"verdict": "no", "reason": "still starting"}' }],
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: { input: 9000, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 9012, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
            stopReason: "stop" as const,
            timestamp: Date.now(),
        }));

        await runTurnEnd(handlers, ctx, 1, "I restarted the services.");
        expect(isCacheReuseViable("goal-integration-session")).toBe(false);

        // Run 2: no longer worth re-sending the conversation at full price on
        // the session model — fall back to the cheapest authenticated model
        // with a standalone transcript.
        for (const handler of handlers.get("context") ?? []) {
            await handler({ type: "context", messages: [{ role: "user", content: "check again", timestamp: 3 }] } as never, ctx);
        }
        await runTurnEnd(handlers, ctx, 2, "Still restarting.");

        expect(fakeCompleteSimple).toHaveBeenCalledTimes(2);
        const [fallbackModel, fallbackContext] = fakeCompleteSimple.mock.calls[1] as unknown as [
            { id: string },
            { systemPrompt?: string; messages: Array<{ content: unknown }> },
        ];
        expect(fallbackModel.id).toBe("claude-haiku-4-5");
        expect(fallbackContext.systemPrompt).toBeUndefined();
        expect(fallbackContext.messages).toHaveLength(1);
        expect(fallbackContext.messages[0]!.content as string).toContain("Conversation so far:");
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
