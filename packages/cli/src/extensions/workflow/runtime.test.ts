import { describe, expect, test } from "bun:test";
import { runWorkflow, WORKFLOW_MAX_TOTAL_AGENTS, type RunSingleAgentFn } from "./runtime.js";
import type { WorkflowDetails } from "./types.js";
import type { SingleResult } from "../subagent/types.js";

/**
 * Tests for the dynamic workflow runtime. All agent execution is stubbed via
 * the injectable `runSingleAgentFn` seam — no real model/network/subagent
 * calls. Fully hermetic: no filesystem or HOME dependence.
 */

const ZERO_USAGE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 };

function successResult(agentName: string, task: string, text: string): SingleResult {
    return {
        agent: agentName,
        agentSource: "user",
        task,
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
        stderr: "",
        usage: { ...ZERO_USAGE },
        model: "fake-model",
    };
}

function failResult(agentName: string, task: string, error: string): SingleResult {
    return {
        agent: agentName,
        agentSource: "user",
        task,
        exitCode: 1,
        messages: [],
        stderr: error,
        usage: { ...ZERO_USAGE },
        errorMessage: error,
    };
}

/** Build a fake single-agent runner matching runSingleAgent's positional signature. */
function makeFakeRunner(
    behavior: (task: string, signal: AbortSignal | undefined) => { text: string } | { error: string },
    onCall?: (task: string, signal: AbortSignal | undefined) => void,
): RunSingleAgentFn {
    return (async (
        _defaultCwd: string,
        _agents: unknown[],
        agentName: string,
        task: string,
        _cwd: string | undefined,
        _step: number | undefined,
        signal: AbortSignal | undefined,
    ): Promise<SingleResult> => {
        onCall?.(task, signal);
        const outcome = behavior(task, signal);
        return "error" in outcome ? failResult(agentName, task, outcome.error) : successResult(agentName, task, outcome.text);
    }) as unknown as RunSingleAgentFn;
}

const ctx = { cwd: "/tmp/workflow-test" };

describe("runWorkflow — agent()", () => {
    test("returns the agent's text result and produces one phase", async () => {
        const runner = makeFakeRunner((task) => ({ text: `echo:${task}` }));
        const { details, text } = await runWorkflow({
            script: "return await agent('hello');",
            ctx,
            runSingleAgentFn: runner,
        });

        expect(text).toBe("echo:hello");
        expect(details.status).toBe("done");
        expect(details.phases).toHaveLength(1);
        expect(details.phases[0].agents).toHaveLength(1);
        expect(details.phases[0].agents[0].status).toBe("done");
        expect(details.phases[0].agents[0].result).toBe("echo:hello");
        expect(details.totalAgents).toBe(1);
        expect(details.totalTokens).toBe(3);
    });

    test("parses JSON when opts.schema is set, falls back to raw text on parse failure", async () => {
        const runner = makeFakeRunner((task) => ({ text: task === "json" ? '{"ok":true}' : "not json" }));

        const parsed = await runWorkflow({
            script: "return await agent('json', { schema: {} });",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(parsed.details.result).toEqual({ ok: true });

        const fallback = await runWorkflow({
            script: "return await agent('nope', { schema: {} });",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(fallback.details.result).toBe("not json");
    });

    test("second agent() call creates a second phase", async () => {
        const runner = makeFakeRunner((task) => ({ text: task }));
        const { details } = await runWorkflow({
            script: "await agent('one'); await agent('two'); return 'done';",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(details.phases).toHaveLength(2);
    });
});

describe("runWorkflow — pipeline()", () => {
    test("fans out to N agents in ONE phase", async () => {
        const runner = makeFakeRunner((task) => ({ text: `out:${task}` }));
        const { details, text } = await runWorkflow({
            script: "return await pipeline([1,2,3,4], (item) => agent('item ' + item));",
            ctx,
            runSingleAgentFn: runner,
        });

        expect(details.phases).toHaveLength(1);
        expect(details.phases[0].agents).toHaveLength(4);
        expect(JSON.parse(text)).toEqual(["out:item 1", "out:item 2", "out:item 3", "out:item 4"]);
    });

    test("rejects a non-array first argument", async () => {
        const runner = makeFakeRunner(() => ({ text: "x" }));
        const { details } = await runWorkflow({
            script: "return await pipeline('not-an-array', (item) => agent(item));",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(details.status).toBe("error");
        expect(details.error).toContain("array");
    });
});

describe("runWorkflow — caps", () => {
    test("throws a clear error past the 1000-agent limit", async () => {
        const runner = makeFakeRunner(() => ({ text: "x" }));
        const items = Array.from({ length: WORKFLOW_MAX_TOTAL_AGENTS + 1 }, (_, i) => i);
        const { details } = await runWorkflow({
            script: "return await pipeline(args, (item) => agent('item ' + item));",
            args: items,
            ctx,
            runSingleAgentFn: runner,
        });

        expect(details.status).toBe("error");
        expect(details.error).toContain(`${WORKFLOW_MAX_TOTAL_AGENTS}-agent limit`);
        expect(details.totalAgents).toBe(WORKFLOW_MAX_TOTAL_AGENTS);
    }, 15000);
});

describe("runWorkflow — args", () => {
    test("args is visible to the script", async () => {
        const runner = makeFakeRunner(() => ({ text: "unused" }));
        const { text } = await runWorkflow({
            script: "return args.x + args.y;",
            args: { x: 40, y: 2 },
            ctx,
            runSingleAgentFn: runner,
        });
        expect(text).toBe("42");
    });
});

describe("runWorkflow — error handling", () => {
    test("a thrown script error sets status:error instead of throwing", async () => {
        const runner = makeFakeRunner(() => ({ text: "unused" }));
        const result = await runWorkflow({
            script: "throw new Error('boom');",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(result.details.status).toBe("error");
        expect(result.details.error).toBe("boom");
    });

    test("an agent() failure surfaces as a script error, not an uncaught throw", async () => {
        const runner = makeFakeRunner(() => ({ error: "agent blew up" }));
        const result = await runWorkflow({
            script: "return await agent('will fail');",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(result.details.status).toBe("error");
        expect(result.details.error).toBe("agent blew up");
        expect(result.details.phases[0].agents[0].status).toBe("error");
    });

    test("a script syntax error sets status:error instead of throwing", async () => {
        const runner = makeFakeRunner(() => ({ text: "unused" }));
        const result = await runWorkflow({
            script: "this is not valid javascript (((",
            ctx,
            runSingleAgentFn: runner,
        });
        expect(result.details.status).toBe("error");
        expect(result.details.error).toContain("Script syntax error");
    });
});

describe("runWorkflow — onUpdate", () => {
    test("is called on running and done transitions", async () => {
        const runner = makeFakeRunner((task) => ({ text: task }));
        const updates: WorkflowDetails[] = [];
        await runWorkflow({
            script: "return await agent('hi');",
            ctx,
            runSingleAgentFn: runner,
            onUpdate: (d) => updates.push(JSON.parse(JSON.stringify(d))),
        });

        expect(updates.length).toBeGreaterThanOrEqual(2);
        expect(updates.some((d) => d.phases[0]?.agents[0]?.status === "running")).toBe(true);
        expect(updates.some((d) => d.phases[0]?.agents[0]?.status === "done")).toBe(true);
        expect(updates[updates.length - 1].status).toBe("done");
    });
});

describe("runWorkflow — abort", () => {
    test("short-circuits before running the script when already aborted", async () => {
        let called = false;
        const runner = makeFakeRunner(() => {
            called = true;
            return { text: "x" };
        });
        const controller = new AbortController();
        controller.abort();

        const { details } = await runWorkflow({
            script: "return await agent('hi');",
            ctx,
            signal: controller.signal,
            runSingleAgentFn: runner,
        });

        expect(called).toBe(false);
        expect(details.status).toBe("error");
        expect(details.error).toContain("aborted");
    });

    test("threads the AbortSignal through to the single-agent runner", async () => {
        let capturedSignal: AbortSignal | undefined;
        const runner = makeFakeRunner(
            () => ({ text: "x" }),
            (_task, signal) => {
                capturedSignal = signal;
            },
        );
        const controller = new AbortController();

        await runWorkflow({
            script: "return await agent('hi');",
            ctx,
            signal: controller.signal,
            runSingleAgentFn: runner,
        });

        expect(capturedSignal).toBe(controller.signal);
    });
});
