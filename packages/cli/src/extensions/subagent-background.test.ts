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

function harness(runAgent: (...args: any[]) => Promise<SingleResult>) {
    let tool: any;
    let shutdown: (() => void | Promise<void>) | undefined;
    const sent: Array<{ content: string; details?: unknown; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
    const pi = {
        registerTool(value: any) { tool = value; },
        on(event: string, handler: () => void) {
            if (event === "session_shutdown") shutdown = handler;
        },
        sendMessage(message: { content: string; details?: unknown }, options?: { deliverAs?: string; triggerTurn?: boolean }) {
            sent.push({ content: message.content, details: message.details, options });
        },
    };
    subagentExtension(pi as any, runAgent as any);
    return { tool, sent, shutdown: async () => { await shutdown?.(); } };
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
};

describe("background subagents", () => {
    test("caps globally reserved subagent slots", () => {
        const release = reserveSubagentSlots(2, 2)!;
        try {
            expect(hasActiveSubagents()).toBe(true);
            expect(reserveSubagentSlots(1, 2)).toBeUndefined();
        } finally {
            release();
        }
        expect(hasActiveSubagents()).toBe(false);
    });

    test("returns immediately and injects the result as a follow-up when done", async () => {
        let finish!: (value: SingleResult) => void;
        const runAgent = mock(() => new Promise<SingleResult>((resolve) => { finish = resolve; }));
        const { tool, sent } = harness(runAgent);

        const launched = await tool.execute("call-1", { agent: "task", task: "Investigate" }, undefined, undefined, ctx);

        expect(launched.content[0].text).toContain("running in the background");
        expect(sent).toEqual([]);

        finish(result);
        await nextTask();

        expect(sent).toHaveLength(1);
        expect(sent[0].content).toContain("Finished investigation");
        expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
        expect(sent[0].details).toMatchObject({ taskId: expect.any(String), mode: "single" });
    });

    test("delivers chain and parallel results after returning", async () => {
        const chainRun = mock((...args: any[]) => Promise.resolve(
            resultFor(args[3], args[3] === "first" ? "one" : "two"),
        ));
        const chain = harness(chainRun);

        await chain.tool.execute("call-chain", {
            chain: [
                { agent: "task", task: "first" },
                { agent: "task", task: "after {previous}" },
            ],
        }, undefined, undefined, ctx);
        await nextTask();

        expect(chainRun).toHaveBeenCalledTimes(2);
        expect(chainRun.mock.calls[1][3]).toBe("after one");
        expect(chain.sent[0].content).toContain("two");

        const parallel = harness(mock((...args: any[]) => Promise.resolve(resultFor(args[3], `done ${args[3]}`))));
        await parallel.tool.execute("call-parallel", {
            tasks: [
                { agent: "task", task: "alpha" },
                { agent: "task", task: "beta" },
            ],
        }, undefined, undefined, ctx);
        await nextTask();

        expect(parallel.sent[0].content).toContain("done alpha");
        expect(parallel.sent[0].content).toContain("done beta");
    });

    test("aborts background work when the parent turn is canceled", async () => {
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

        await tool.execute("call-2", { agent: "task", task: "Investigate" }, turn.signal, undefined, ctx);
        turn.abort();
        await nextTask();

        expect(aborted).toBe(true);
        expect(sent).toEqual([]);
    });

    test("aborts background work on session shutdown without injecting a result", async () => {
        const runAgent = mock((...args: any[]) => new Promise<SingleResult>((_resolve, reject) => {
            const signal = args[6] as AbortSignal;
            signal.addEventListener("abort", () => reject(new Error("Subagent was aborted")), { once: true });
        }));
        const { tool, sent, shutdown } = harness(runAgent);

        await tool.execute("call-3", { agent: "task", task: "Investigate" }, undefined, undefined, ctx);
        await shutdown();

        expect(sent).toEqual([]);
    });
});
