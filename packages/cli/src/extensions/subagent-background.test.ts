import { describe, expect, mock, test } from "bun:test";
import { subagentExtension, type SingleResult } from "./subagent.js";
import { hasActiveSubagents, reserveSubagentSlots } from "./subagent/background-state.js";

const result: SingleResult = {
    agent: "task",
    agentSource: "user",
    task: "Investigate",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Finished investigation" }] } as any],
    stderr: "",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
};

function resultFor(task: string, output: string): SingleResult {
    return {
        ...result,
        task,
        messages: [{ role: "assistant", content: [{ type: "text", text: output }] } as any],
    };
}

function spawned(sessionId = "child-1") {
    return {
        ok: true as const,
        sessionId,
        runnerId: "runner-1",
        cwd: process.cwd(),
        pending: false,
        shareUrl: `https://relay.example/session/${sessionId}`,
    };
}

function harness(
    runAgent: (...args: any[]) => Promise<SingleResult>,
    spawnSubagent?: (...args: any[]) => Promise<any>,
    limits = { maxParallelTasks: 8, maxConcurrency: 4 },
) {
    let tool: any;
    let shutdown: (() => void | Promise<void>) | undefined;
    let sessionSwitch: ((event: { reason?: string }) => void | Promise<void>) | undefined;
    let relayTrigger: ((trigger: any) => void) | undefined;
    const cleaned: string[] = [];
    const sent: Array<{ content: string; details?: unknown; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
    const pi = {
        registerTool(value: any) { tool = value; },
        on(event: string, handler: () => void) {
            if (event === "session_shutdown") shutdown = handler;
            if (event === "session_switch") sessionSwitch = handler;
        },
        sendMessage(message: { content: string; details?: unknown }, options?: { deliverAs?: string; triggerTurn?: boolean }) {
            sent.push({ content: message.content, details: message.details, options });
        },
    };
    subagentExtension(pi as any, runAgent as any, spawnSubagent as any, {
        getGlobalConfig: () => ({ subagent: limits } as any),
        discoverAgents: () => ({
            agents: [{ name: "task", description: "task", systemPrompt: "", source: "user", filePath: "" }],
            projectAgentsDir: null,
        }),
        cleanupVisibleChild: (sessionId) => { cleaned.push(sessionId); },
        subscribeToRelayTriggers: (listener) => {
            relayTrigger = listener;
            return () => { relayTrigger = undefined; };
        },
    });
    return {
        tool,
        sent,
        cleaned,
        triggerRelay: (trigger: any) => relayTrigger?.(trigger),
        newSession: async () => { await sessionSwitch?.({ reason: "new" }); },
        shutdown: async () => { await shutdown?.(); },
    };
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
};

describe("background subagents", () => {
    test("caps globally reserved subagent slots for in-process chains", () => {
        const release = reserveSubagentSlots(2, 2)!;
        try {
            expect(hasActiveSubagents()).toBe(true);
            expect(reserveSubagentSlots(1, 2)).toBeUndefined();
        } finally {
            release();
        }
        expect(hasActiveSubagents()).toBe(false);
    });

    test("starts a single subagent as a linked child session without a follow-up result", async () => {
        const runAgent = mock(() => Promise.resolve(result));
        const spawnSubagent = mock(() => Promise.resolve(spawned("child-single")));
        const { tool, sent, cleaned, newSession, shutdown } = harness(runAgent, spawnSubagent);

        const launched = await tool.execute("call-1", { agent: "task", task: "Investigate" }, undefined, undefined, ctx);

        expect(launched.content[0].text).toContain("child session started");
        expect(launched.content[0].text).toContain("automatically as a steer trigger");
        expect(launched.content[0].text).toContain("child-single");
        expect(sent).toEqual([]);
        expect(runAgent).not.toHaveBeenCalled();
        expect(spawnSubagent).toHaveBeenCalledWith(ctx, expect.objectContaining({ name: "task" }), "Investigate", undefined, undefined, undefined);
        expect(launched.details).toMatchObject({
            background: { taskId: expect.any(String), sessions: [{ sessionId: "child-single" }] },
        });
        await newSession();
        expect(cleaned).toEqual(["child-single"]);
        await shutdown();
    });

    test("falls back to an in-process single agent without runner spawn capability", async () => {
        const runAgent = mock(() => Promise.resolve(result));
        const { tool, sent } = harness(runAgent);

        await tool.execute("call-fallback", { agent: "task", task: "Investigate" }, undefined, undefined, ctx);
        await nextTask();
        expect(runAgent).toHaveBeenCalledTimes(1);
        expect(sent[0]?.content).toContain("Finished investigation");
    });

    test("starts one visible child session per parallel task", async () => {
        const spawnSubagent = mock((_: unknown, _agent: unknown, task: string) =>
            Promise.resolve(spawned(`child-${task}`)),
        );
        const { tool, sent, shutdown } = harness(mock(() => Promise.resolve(result)), spawnSubagent);

        const launched = await tool.execute("call-parallel", {
            tasks: [
                { agent: "task", task: "alpha" },
                { agent: "task", task: "beta" },
            ],
        }, undefined, undefined, ctx);

        expect(spawnSubagent).toHaveBeenCalledTimes(2);
        expect(launched.content[0].text).toContain("2/2 child sessions started");
        expect(launched.content[0].text).toContain("child-alpha");
        expect(launched.content[0].text).toContain("child-beta");
        expect(sent).toEqual([]);
        await shutdown();
    });


    test("reserves every in-process parallel task against the global limit", async () => {
        const { tool, shutdown } = harness(mock(() => Promise.resolve(result)), undefined, {
            maxParallelTasks: 2,
            maxConcurrency: 2,
        });
        await tool.execute("call-offline-parallel", {
            tasks: [
                { agent: "task", task: "alpha" },
                { agent: "task", task: "beta" },
            ],
        }, undefined, undefined, ctx);
        const blocked = await tool.execute("call-blocked", { agent: "task", task: "gamma" }, undefined, undefined, ctx);
        expect(blocked.content[0].text).toContain("Too many active subagents");
        await nextTask();
        await shutdown();
    });

    test("keeps visible parallel children within the configured concurrency limit", async () => {
        const spawnSubagent = mock((_: unknown, _agent: unknown, task: string) => Promise.resolve(spawned(`child-${task}`)));
        const { tool, triggerRelay } = harness(mock(() => Promise.resolve(result)), spawnSubagent, {
            maxParallelTasks: 2,
            maxConcurrency: 1,
        });

        const launched = await tool.execute("call-parallel", {
            tasks: [
                { agent: "task", task: "alpha" },
                { agent: "task", task: "beta" },
            ],
        }, undefined, undefined, ctx);
        expect(spawnSubagent).toHaveBeenCalledTimes(1);
        expect(launched.content[0].text).toContain("1 task queued");

        const blocked = await tool.execute("call-blocked", { agent: "task", task: "gamma" }, undefined, undefined, ctx);
        expect(blocked.content[0].text).toContain("Too many active subagents");

        triggerRelay({ type: "session_error", sourceSessionId: "child-alpha" });
        await nextTask();
        expect(spawnSubagent).toHaveBeenCalledTimes(2);
        triggerRelay({ type: "session_complete", sourceSessionId: "child-beta" });
    });

    test("keeps chain execution in-process so each step receives the prior output", async () => {
        const chainRun = mock((...args: any[]) => Promise.resolve(
            resultFor(args[3], args[3] === "first" ? "one" : "two"),
        ));
        const spawnSubagent = mock(() => Promise.resolve(spawned()));
        const { tool, sent } = harness(chainRun, spawnSubagent);

        await tool.execute("call-chain", {
            chain: [
                { agent: "task", task: "first" },
                { agent: "task", task: "after {previous}" },
            ],
        }, undefined, undefined, ctx);
        await nextTask();

        expect(chainRun).toHaveBeenCalledTimes(2);
        expect(chainRun.mock.calls[1][3]).toBe("after one");
        expect(spawnSubagent).not.toHaveBeenCalled();
        expect(sent[0].content).toContain("two");
    });

    test("aborts an in-process chain when the parent turn is canceled", async () => {
        let aborted = false;
        const runAgent = mock((...args: any[]) => new Promise<SingleResult>((_resolve, reject) => {
            const signal = args[6] as AbortSignal;
            signal.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("Subagent was aborted"));
            }, { once: true });
        }));
        const { tool, sent } = harness(runAgent);
        const turn = new AbortController();

        await tool.execute("call-2", { chain: [{ agent: "task", task: "Investigate" }] }, turn.signal, undefined, ctx);
        turn.abort();
        await nextTask();

        expect(aborted).toBe(true);
        expect(sent).toEqual([]);
    });

    test("aborts in-process chain work on session shutdown without injecting a result", async () => {
        const runAgent = mock((...args: any[]) => new Promise<SingleResult>((_resolve, reject) => {
            const signal = args[6] as AbortSignal;
            signal.addEventListener("abort", () => reject(new Error("Subagent was aborted")), { once: true });
        }));
        const { tool, sent, shutdown } = harness(runAgent);

        await tool.execute("call-3", { chain: [{ agent: "task", task: "Investigate" }] }, undefined, undefined, ctx);
        await shutdown();

        expect(sent).toEqual([]);
    });
});
