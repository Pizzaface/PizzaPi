/**
 * Dynamic workflow runtime — executes a user-authored JS script that
 * orchestrates subagents via `agent()` / `pipeline()` primitives.
 *
 * Mirrors Claude Code's "dynamic workflows": the script's intermediate
 * results live in script-local variables, never in the parent's context
 * window. Only the script's `return` value becomes the tool result.
 *
 * Reuses the existing subagent engine (`runSingleAgent`,
 * `mapWithConcurrencyLimit`) for actual agent execution — this module only
 * adds the scripting sandbox and progress bookkeeping on top.
 */

import { BUILTIN_AGENTS } from "../subagent-agents.js";
import {
    runSingleAgent,
    mapWithConcurrencyLimit,
    parseModelString,
    type ModelOverride,
    type ModelRegistryLike,
} from "../subagent/engine.js";
import { getFinalOutput, isFailed } from "../subagent/types.js";
import type { WorkflowAgentInfo, WorkflowDetails, WorkflowPhase } from "./types.js";

// ── Caps ─────────────────────────────────────────────────────────────────
// ponytail: hardcoded rather than made project-configurable — a project's
// .pizzapi/config.json must not be able to raise fan-out limits for an
// untrusted repo. subagent's DEFAULT_MAX_CONCURRENCY (4) is tuned for its
// smaller parallel-tasks feature; workflows are meant for larger fan-out,
// so this uses its own higher cap instead of importing that constant.
export const WORKFLOW_MAX_CONCURRENCY = 16;
export const WORKFLOW_MAX_TOTAL_AGENTS = 1000;

/** The single-agent runner signature, injectable for tests. */
export type RunSingleAgentFn = typeof runSingleAgent;

export interface RunWorkflowOptions {
    script: string;
    args?: unknown;
    name?: string;
    signal?: AbortSignal;
    onUpdate?: (details: WorkflowDetails) => void;
    /** Default model for agent() calls that don't specify their own. */
    modelDefault?: ModelOverride;
    ctx: {
        cwd: string;
        modelRegistry?: ModelRegistryLike;
    };
    /** Injectable seam for tests — defaults to the real subagent engine. */
    runSingleAgentFn?: RunSingleAgentFn;
}

export interface RunWorkflowResult {
    details: WorkflowDetails;
    /** Text form of the script's return value, for the tool's `content`. */
    text: string;
}

interface AgentCallOptions {
    label?: string;
    model?: ModelOverride | string;
    /** If provided, the agent's text result is JSON.parse'd and returned as an object. */
    schema?: unknown;
}

function slugPrompt(prompt: string): string {
    const singleLine = prompt.replace(/\s+/g, " ").trim();
    if (!singleLine) return "agent";
    return singleLine.length > 48 ? `${singleLine.slice(0, 45)}...` : singleLine;
}

function resolveModelOpt(model: ModelOverride | string | undefined): ModelOverride | undefined {
    if (!model) return undefined;
    return typeof model === "string" ? parseModelString(model) : model;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
    const { script, args, name, signal, onUpdate, modelDefault, ctx } = opts;
    const runSingleAgentFn = opts.runSingleAgentFn ?? runSingleAgent;

    const details: WorkflowDetails = {
        name,
        status: "running",
        phases: [],
        totalAgents: 0,
        totalTokens: 0,
    };

    const emit = () => onUpdate?.(details);

    let agentCounter = 0;
    // ponytail: single mutable "active phase" pointer, not an async-context
    // stack. Works for the documented usage (await one pipeline() at a time);
    // overlapping un-awaited pipeline() calls in the same script would
    // misattribute agents to the wrong phase. Upgrade to AsyncLocalStorage if
    // that pattern becomes common.
    let activePhase: WorkflowPhase | null = null;

    async function runOneAgent(phase: WorkflowPhase, prompt: string, agentOpts?: AgentCallOptions): Promise<string> {
        if (details.totalAgents >= WORKFLOW_MAX_TOTAL_AGENTS) {
            throw new Error(`Workflow exceeded ${WORKFLOW_MAX_TOTAL_AGENTS}-agent limit`);
        }
        details.totalAgents++;

        const info: WorkflowAgentInfo = {
            id: `a${++agentCounter}`,
            label: agentOpts?.label,
            prompt,
            status: "running",
        };
        phase.agents.push(info);
        emit();

        const result = await runSingleAgentFn(
            ctx.cwd,
            BUILTIN_AGENTS,
            "task",
            prompt,
            undefined,
            undefined,
            signal,
            undefined,
            () => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [] }),
            resolveModelOpt(agentOpts?.model) ?? modelDefault,
            ctx.modelRegistry,
        );

        info.model = result.model;
        info.tokens = result.usage.input + result.usage.output;
        details.totalTokens += info.tokens;

        if (isFailed(result)) {
            info.status = "error";
            info.error = result.errorMessage || result.stderr || "agent failed";
            emit();
            throw new Error(info.error);
        }

        const text = getFinalOutput(result.messages);
        info.status = "done";
        info.result = text;
        emit();
        return text;
    }

    async function agent(prompt: string, agentOpts?: AgentCallOptions): Promise<unknown> {
        const phase = activePhase ?? { label: agentOpts?.label ?? slugPrompt(prompt), agents: [] };
        if (!activePhase) {
            details.phases.push(phase);
            emit();
        }
        const text = await runOneAgent(phase, prompt, agentOpts);
        if (agentOpts?.schema) {
            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        }
        return text;
    }

    async function pipeline<TItem, TOut>(list: TItem[], mapper: (item: TItem, index: number) => Promise<TOut>): Promise<TOut[]> {
        if (!Array.isArray(list)) throw new Error("pipeline() expects an array as its first argument");
        const phase: WorkflowPhase = { label: `pipeline (${list.length} items)`, agents: [] };
        details.phases.push(phase);
        emit();

        const previousPhase = activePhase;
        activePhase = phase;
        try {
            return await mapWithConcurrencyLimit(list, WORKFLOW_MAX_CONCURRENCY, (item, index) => mapper(item, index));
        } finally {
            activePhase = previousPhase;
        }
    }

    // ponytail: run the script in-process via an AsyncFunction sandbox rather
    // than a subprocess or node:vm. The tool-call boundary already provides
    // context isolation — every agent()/pipeline() call spawns an isolated
    // AgentSession whose transcript never touches the parent, and only this
    // tool's returned value is surfaced. A subprocess/vm sandbox would add
    // serialization overhead for zero additional isolation here.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
    ) => (agentFn: typeof agent, pipelineFn: typeof pipeline, argsValue: unknown, consoleValue: Console) => Promise<unknown>;

    let scriptFn: (agentFn: typeof agent, pipelineFn: typeof pipeline, argsValue: unknown, consoleValue: Console) => Promise<unknown>;
    try {
        scriptFn = new AsyncFunction("agent", "pipeline", "args", "console", script);
    } catch (err) {
        details.status = "error";
        details.error = `Script syntax error: ${err instanceof Error ? err.message : String(err)}`;
        emit();
        return { details, text: details.error };
    }

    try {
        if (signal?.aborted) throw new Error("Workflow was aborted");
        const result = await scriptFn(agent, pipeline, args, console);
        details.status = "done";
        details.result = result;
        emit();
        const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
        return { details, text };
    } catch (err) {
        details.status = "error";
        details.error = err instanceof Error ? err.message : String(err);
        emit();
        return { details, text: `Workflow failed: ${details.error}` };
    }
}
