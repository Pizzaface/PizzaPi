/**
 * Dynamic workflow runtime — executes a user-authored JS script that
 * orchestrates subagents via `agent()` / `pipeline()` primitives.
 *
 * Mirrors Claude Code's "dynamic workflows": the script's intermediate
 * results live in script-local variables, never in the parent's context
 * window. Only the script's `return` value becomes the tool result.
 *
 * Reuses the existing subagent engine (`runSingleAgent`) for actual agent
 * execution — this module only adds the scripting sandbox and progress
 * bookkeeping on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { BUILTIN_AGENTS } from "../subagent-agents.js";
import { runSingleAgent, parseModelString, type ModelOverride, type ModelRegistryLike } from "../subagent/engine.js";
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

/** Context propagated to agent() calls made from inside a pipeline() mapper. */
interface PhaseContext {
    phase: WorkflowPhase;
    signal: AbortSignal | undefined;
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

/**
 * Tiny counting semaphore. Created fresh per `runWorkflow()` call and shared
 * by every `agent()` invocation made during that run (whether called
 * directly or from inside a `pipeline()` mapper, including bare
 * `Promise.all` fan-out that bypasses pipeline's own bounded mapper) — this
 * is what actually enforces the concurrency cap, not `pipeline()`'s own
 * bounded loop.
 */
function createSemaphore(max: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    const release = () => {
        active--;
        const next = queue.shift();
        if (next) {
            active++;
            next();
        }
    };
    const acquire = (): Promise<() => void> => {
        if (active < max) {
            active++;
            return Promise.resolve(release);
        }
        return new Promise((resolve) => queue.push(() => resolve(release)));
    };
    return { acquire };
}

// SECURITY: normalize a script's return value into something guaranteed
// JSON-serializable before it's stored in `details.result` / broadcast via
// onUpdate. BigInt is stringified rather than rejected (it round-trips
// losslessly for display); a circular reference has no safe normalization,
// so it throws a clear error instead (caught by the caller and surfaced as
// a normal workflow error, not an uncaught exception from JSON.stringify).
function ensureSerializable(value: unknown): unknown {
    const seen = new WeakSet<object>();
    const replacer = (_key: string, val: unknown) => {
        if (typeof val === "bigint") return `${val}n`;
        if (val !== null && typeof val === "object") {
            if (seen.has(val as object)) throw new Error("circular reference");
            seen.add(val as object);
        }
        return val;
    };
    let json: string | undefined;
    try {
        json = JSON.stringify(value, replacer);
    } catch (err) {
        throw new Error(`Workflow result is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return json === undefined ? undefined : JSON.parse(json);
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
    const agentSemaphore = createSemaphore(WORKFLOW_MAX_CONCURRENCY);
    // Per-run async context: which phase (and effective abort signal) the
    // *currently executing* agent()/pipeline() call belongs to. Replaces a
    // shared mutable "activePhase" field, which would misattribute agents to
    // the wrong phase across overlapping/nested pipeline() calls — this
    // storage is correctly scoped per async call chain even when multiple
    // pipelines run concurrently.
    const phaseContext = new AsyncLocalStorage<PhaseContext>();

    async function runOneAgent(phase: WorkflowPhase, prompt: string, agentOpts: AgentCallOptions | undefined, effectiveSignal: AbortSignal | undefined): Promise<string> {
        if (details.totalAgents >= WORKFLOW_MAX_TOTAL_AGENTS) {
            throw new Error(`Workflow exceeded ${WORKFLOW_MAX_TOTAL_AGENTS}-agent limit`);
        }
        details.totalAgents++;

        const info: WorkflowAgentInfo = {
            id: `a${++agentCounter}`,
            label: agentOpts?.label,
            prompt,
            status: "pending",
        };
        phase.agents.push(info);
        emit();

        try {
            // GLOBAL per-run cap: every agent() call funnels through this
            // semaphore before actually invoking the runner, regardless of
            // whether it was called directly, from a pipeline() mapper, or
            // from a bare Promise.all fan-out that bypasses pipeline
            // entirely.
            const release = await agentSemaphore.acquire();
            try {
                info.status = "running";
                emit();

                const result = await runSingleAgentFn(
                    ctx.cwd,
                    BUILTIN_AGENTS,
                    "task",
                    prompt,
                    undefined,
                    undefined,
                    effectiveSignal,
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
            } finally {
                release();
            }
        } catch (err) {
            // Any throw along this path (including setup/cancellation
            // failures in runSingleAgentFn itself, not just an isFailed()
            // result) must leave the entry in a terminal state — otherwise
            // it stays "pending"/"running" forever in the UI.
            if (info.status === "pending" || info.status === "running") {
                info.status = "error";
                info.error = err instanceof Error ? err.message : String(err);
                emit();
            }
            throw err;
        }
    }

    async function agent(prompt: string, agentOpts?: AgentCallOptions): Promise<unknown> {
        const store = phaseContext.getStore();
        let phase = store?.phase;
        if (!phase) {
            phase = { label: agentOpts?.label ?? slugPrompt(prompt), agents: [] };
            details.phases.push(phase);
            emit();
        }
        const effectiveSignal = store?.signal ?? signal;
        const text = await runOneAgent(phase, prompt, agentOpts, effectiveSignal);
        if (agentOpts?.schema) {
            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        }
        return text;
    }

    async function runPipelineWorkers<TItem, TOut>(list: TItem[], mapper: (item: TItem, index: number) => Promise<TOut>, controller: AbortController): Promise<TOut[]> {
        const limit = Math.max(1, Math.min(WORKFLOW_MAX_CONCURRENCY, list.length));
        const results: TOut[] = new Array(list.length);
        let nextIndex = 0;
        let firstError: unknown;
        let hasError = false;

        const workers = new Array(limit).fill(null).map(async () => {
            while (!controller.signal.aborted) {
                const current = nextIndex++;
                if (current >= list.length) return;
                try {
                    results[current] = await mapper(list[current], current);
                } catch (err) {
                    // On the FIRST failure, abort the pipeline-scoped signal
                    // so siblings (both queued and in-flight) stop, then
                    // fall through to await every worker settling below —
                    // never return while a sibling might still be mutating
                    // `details` in the background.
                    if (!hasError) {
                        hasError = true;
                        firstError = err;
                    }
                    controller.abort();
                    return;
                }
            }
        });

        await Promise.allSettled(workers);
        if (hasError) throw firstError;
        return results;
    }

    async function pipeline<TItem, TOut>(list: TItem[], mapper: (item: TItem, index: number) => Promise<TOut>): Promise<TOut[]> {
        if (!Array.isArray(list)) throw new Error("pipeline() expects an array as its first argument");
        const phase: WorkflowPhase = { label: `pipeline (${list.length} items)`, agents: [] };
        details.phases.push(phase);
        emit();

        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        signal?.addEventListener("abort", forwardAbort, { once: true });

        try {
            return await phaseContext.run({ phase, signal: controller.signal }, () => runPipelineWorkers(list, mapper, controller));
        } finally {
            signal?.removeEventListener("abort", forwardAbort);
        }
    }

    // ponytail: run the script in-process via an AsyncFunction sandbox rather
    // than a subprocess or node:vm. TRUST MODEL: a workflow script is
    // authored by the agent itself (via run_workflow's `script` param) at
    // the same trust level as the agent's other tools (bash, write) — it is
    // NOT untrusted third-party code, so `AsyncFunction` needs to provide
    // convenient scripting, not sandboxing. The tool-call boundary already
    // provides the isolation that matters here: every agent()/pipeline()
    // call spawns an isolated AgentSession whose transcript never touches
    // the parent, and only this tool's returned value is surfaced. If
    // executing genuinely untrusted scripts (e.g. fetched from a third
    // party) ever becomes a requirement, upgrade to subprocess/worker
    // isolation — AsyncFunction alone is not a security sandbox.
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
        const rawResult = await scriptFn(agent, pipeline, args, console);
        const result = ensureSerializable(rawResult);
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
