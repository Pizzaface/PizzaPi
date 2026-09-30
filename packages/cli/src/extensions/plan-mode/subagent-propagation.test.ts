/**
 * Parent-side wiring for plan-mode → subagent propagation:
 *
 *   - the plan-mode tool_call guard lets `subagent` through but still blocks
 *     `spawn_session` (and write tools);
 *   - the `subagent` tool snapshots plan mode at call time and forces
 *     `planMode: true` into every agent it runs (single / parallel / chain),
 *     even if the parent leaves plan mode while the run is in flight;
 *   - `run_workflow`'s runtime does the same for every agent() call.
 *
 * The child-side enforcement (turn-one write refusal inside a real
 * AgentSession) is covered by ../subagent/plan-mode.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planModeToggleExtension, setPlanModeFromRemote, isPlanModeEnabled } from "./extension.js";
import { subagentExtension } from "../subagent/index.js";
import type { SingleResult } from "../subagent/types.js";
import type { SubagentRunOptions } from "../subagent/plan-mode.js";
import { runWorkflow, type RunSingleAgentFn } from "../workflow/runtime.js";

type Handler = (event: any, ctx?: any) => any;

function makePi() {
    const handlers = new Map<string, Handler[]>();
    const tools: any[] = [];
    const sent: any[] = [];
    const pi = {
        on: (name: string, fn: Handler) => {
            handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        },
        registerTool: (t: any) => tools.push(t),
        registerCommand: () => {},
        appendEntry: () => {},
        sendMessage: (msg: any) => sent.push(msg),
        sendUserMessage: () => {},
    };
    return { pi, handlers, tools, sent };
}

// One plan-mode extension instance drives the module-level state that the
// subagent tool reads via isPlanModeEnabled().
const planPi = makePi();
planModeToggleExtension(planPi.pi as any);
const toolCallGuard = planPi.handlers.get("tool_call")![0];

afterEach(() => {
    setPlanModeFromRemote(false);
});

function okResult(agent: string, task: string): SingleResult {
    return {
        agent,
        agentSource: "user",
        task,
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: `ok:${task}` }] } as any],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    };
}

interface RecordedCall {
    task: string;
    runOptions: SubagentRunOptions | undefined;
}

/** Fake runSingleAgent that records the 15th positional arg (runOptions). */
function recordingRunner(calls: RecordedCall[], beforeReturn?: (task: string) => void | Promise<void>) {
    return (async (...args: any[]) => {
        const task = args[3] as string;
        calls.push({ task, runOptions: args[14] });
        await beforeReturn?.(task);
        return okResult(args[2], task);
    }) as unknown as RunSingleAgentFn;
}

async function runSubagentTool(params: Record<string, unknown>, runner: RunSingleAgentFn) {
    const { pi, tools, sent } = makePi();
    subagentExtension(pi as any, runner as any);
    const tool = tools.find((t) => t.name === "subagent");
    const cwd = mkdtempSync(join(tmpdir(), "pizzapi-plan-subagent-"));
    try {
        const started = await tool.execute("call-1", params, undefined, undefined, { cwd, hasUI: false });
        // The run is backgrounded; wait for its follow-up delivery.
        for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
        return { started, sent };
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

describe("plan-mode tool_call guard", () => {
    test("subagent is allowed in plan mode", async () => {
        setPlanModeFromRemote(true);
        expect(isPlanModeEnabled()).toBe(true);
        expect(await toolCallGuard({ toolName: "subagent", input: { agent: "researcher", task: "look" } })).toBeUndefined();
    });

    test("spawn_session is still blocked, and the reason points at subagent", async () => {
        setPlanModeFromRemote(true);
        const res = await toolCallGuard({ toolName: "spawn_session", input: {} });
        expect(res?.block).toBe(true);
        expect(res.reason).toContain("spawn_session");
        expect(res.reason).toContain("subagent");
    });

    test("write tools are still blocked", async () => {
        setPlanModeFromRemote(true);
        for (const toolName of ["edit", "write", "write_file"]) {
            expect((await toolCallGuard({ toolName, input: {} }))?.block).toBe(true);
        }
    });
});

describe("subagent tool — plan-mode propagation", () => {
    test("parent in plan mode → single run is forced read-only", async () => {
        setPlanModeFromRemote(true);
        const calls: RecordedCall[] = [];
        const { started } = await runSubagentTool({ agent: "researcher", task: "investigate" }, recordingRunner(calls));
        expect(calls).toEqual([{ task: "investigate", runOptions: { planMode: true } }]);
        expect(started.content[0].text).toContain("read-only plan mode");
    });

    test("parent not in plan mode → no plan-mode restriction", async () => {
        const calls: RecordedCall[] = [];
        const { started } = await runSubagentTool({ agent: "researcher", task: "investigate" }, recordingRunner(calls));
        expect(calls).toEqual([{ task: "investigate", runOptions: { planMode: false } }]);
        expect(started.content[0].text).not.toContain("plan mode");
    });

    test("the model cannot opt out via tool params", async () => {
        setPlanModeFromRemote(true);
        const calls: RecordedCall[] = [];
        await runSubagentTool(
            { agent: "researcher", task: "investigate", planMode: false, options: { planMode: false }, readOnly: false },
            recordingRunner(calls),
        );
        expect(calls[0].runOptions).toEqual({ planMode: true });
    });

    test("parallel tasks are all forced read-only", async () => {
        setPlanModeFromRemote(true);
        const calls: RecordedCall[] = [];
        await runSubagentTool(
            { tasks: [{ agent: "a", task: "one" }, { agent: "b", task: "two" }] },
            recordingRunner(calls),
        );
        expect(calls).toHaveLength(2);
        for (const c of calls) expect(c.runOptions).toEqual({ planMode: true });
    });

    test("plan mode is snapshotted at call time: later chain steps stay read-only after the parent exits plan mode", async () => {
        setPlanModeFromRemote(true);
        const calls: RecordedCall[] = [];
        const runner = recordingRunner(calls, (task) => {
            // Parent leaves plan mode while step 1 is still running.
            if (task === "step1") setPlanModeFromRemote(false);
        });
        await runSubagentTool(
            { chain: [{ agent: "a", task: "step1" }, { agent: "b", task: "step2 {previous}" }] },
            runner,
        );
        expect(isPlanModeEnabled()).toBe(false);
        expect(calls).toHaveLength(2);
        expect(calls[0].runOptions).toEqual({ planMode: true });
        expect(calls[1].runOptions).toEqual({ planMode: true });
    });
});

describe("run_workflow runtime — plan-mode propagation", () => {
    const ctx = { cwd: "/tmp/workflow-plan-test" };

    test("defaults to the parent's plan-mode state", async () => {
        setPlanModeFromRemote(true);
        const calls: RecordedCall[] = [];
        await runWorkflow({ script: "return await agent('hi');", ctx, runSingleAgentFn: recordingRunner(calls) });
        expect(calls).toEqual([{ task: "hi", runOptions: { planMode: true } }]);
    });

    test("not in plan mode → agents are unrestricted", async () => {
        const calls: RecordedCall[] = [];
        await runWorkflow({ script: "return await agent('hi');", ctx, runSingleAgentFn: recordingRunner(calls) });
        expect(calls[0].runOptions).toEqual({ planMode: false });
    });
});
