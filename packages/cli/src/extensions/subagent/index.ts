/**
 * Subagent Tool — Delegate tasks to specialized agents with isolated context.
 *
 * Creates an in-process AgentSession for each subagent invocation, giving it
 * an isolated context window. Supports three modes:
 *
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses the pi SDK in-process (createAgentSession + session.prompt) for
 * zero-overhead execution — no child process, no JSON parsing, direct event
 * access for streaming.
 *
 * Adapted from upstream pi subagent extension (examples/extensions/subagent/)
 * with PizzaPi-specific agent discovery paths (~/.pizzapi/agents/,
 * ~/.claude/agents/, .pizzapi/agents/, .claude/agents/) and structured
 * `details` payloads for web UI consumption.
 */

import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type AgentScope, discoverAgents } from "../subagent-agents.js";
import { getPluginAgentPaths } from "../claude-plugins.js";
import { loadGlobalConfig } from "../../config.js";
import {
    DEFAULT_MAX_PARALLEL_TASKS,
    DEFAULT_MAX_CONCURRENCY,
    toFinitePositiveInt,
    isFailed,
    getFinalOutput,
    type OnUpdateCallback,
    type SubagentDetails,
    type SingleResult,
} from "./types.js";
import { runSingleAgent, mapWithConcurrencyLimit } from "./engine.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";

// ── Tool parameter schemas (JSON Schema) ───────────────────────────────

const TaskItemSchema = {
    type: "object",
    properties: {
        agent: { type: "string", description: "Name of the agent to invoke" },
        task: { type: "string", description: "Task to delegate to the agent" },
        cwd: { type: "string", description: "Working directory for the agent process" },
    },
    required: ["agent", "task"],
} as const;

const ChainItemSchema = {
    type: "object",
    properties: {
        agent: { type: "string", description: "Name of the agent to invoke" },
        task: { type: "string", description: "Task with optional {previous} placeholder for prior output" },
        cwd: { type: "string", description: "Working directory for the agent process" },
    },
    required: ["agent", "task"],
} as const;

const SubagentParams = {
    type: "object",
    properties: {
        agent: { type: "string", description: "Name of the agent to invoke (for single mode)" },
        task: { type: "string", description: "Task to delegate (for single mode)" },
        tasks: {
            type: "array",
            description: "Array of {agent, task} for parallel execution",
            items: TaskItemSchema,
        },
        chain: {
            type: "array",
            description: "Array of {agent, task} for sequential execution",
            items: ChainItemSchema,
        },
        agentScope: {
            type: "string",
            enum: ["user", "project", "both"],
            description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
            default: "user",
        },
        confirmProjectAgents: {
            type: "boolean",
            description: "Prompt before running project-local agents. Default: true.",
            default: true,
        },
        cwd: { type: "string", description: "Working directory for the agent process (single mode)" },
    },
} as const;

// ── Extension factory ──────────────────────────────────────────────────

export const subagentExtension = (pi: ExtensionAPI) => {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
            'Default agent scope is "user" (from ~/.pizzapi/agents and ~/.claude/agents).',
            'To enable project-local agents in .pizzapi/agents or .claude/agents, set agentScope: "both" (or "project").',
            "Compatible with Claude Code agent definition files.",
        ].join(" "),
        parameters: SubagentParams as any,

        async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
            // Read concurrency limits from global config only — project-local
            // config must not be able to raise fan-out limits for untrusted repos.
            const globalConfig = loadGlobalConfig();
            const maxParallelTasks = toFinitePositiveInt(globalConfig.subagent?.maxParallelTasks, DEFAULT_MAX_PARALLEL_TASKS);
            const maxConcurrency = toFinitePositiveInt(globalConfig.subagent?.maxConcurrency, DEFAULT_MAX_CONCURRENCY);

            const params = (rawParams ?? {}) as {
                agent?: string;
                task?: string;
                tasks?: Array<{ agent: string; task: string; cwd?: string }>;
                chain?: Array<{ agent: string; task: string; cwd?: string }>;
                agentScope?: AgentScope;
                confirmProjectAgents?: boolean;
                cwd?: string;
            };
            const agentScope: AgentScope = params.agentScope ?? "user";
            const pluginAgentDirs = getPluginAgentPaths(ctx.cwd);
            const discovery = discoverAgents(ctx.cwd, agentScope, { extraUserDirs: pluginAgentDirs });
            const agents = discovery.agents;
            const confirmProjectAgents = params.confirmProjectAgents ?? true;

            const hasChain = (params.chain?.length ?? 0) > 0;
            const hasTasks = (params.tasks?.length ?? 0) > 0;
            const hasSingle = Boolean(params.agent && params.task);
            const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

            const makeDetails =
                (mode: "single" | "parallel" | "chain") =>
                (results: SingleResult[]): SubagentDetails => ({
                    mode,
                    agentScope,
                    projectAgentsDir: discovery.projectAgentsDir,
                    results,
                });

            if (modeCount !== 1) {
                const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails("single")([]),
                };
            }

            // Confirm project-scope agents when required
            if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
                const requestedAgentNames = new Set<string>();
                if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
                if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
                if (params.agent) requestedAgentNames.add(params.agent);

                const projectAgentsRequested = Array.from(requestedAgentNames)
                    .map((name) => agents.find((a) => a.name === name))
                    .filter((a): a is import("../subagent-agents.js").AgentConfig => a?.source === "project");

                if (projectAgentsRequested.length > 0) {
                    if (!ctx.hasUI) {
                        // Fail closed in headless/runner contexts — no UI to confirm
                        const names = projectAgentsRequested.map((a) => a.name).join(", ");
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Refused: project-local agents (${names}) require confirmation but no UI is available. Set confirmProjectAgents: false to allow in headless mode.`,
                                },
                            ],
                            details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                        };
                    }
                    const names = projectAgentsRequested.map((a) => a.name).join(", ");
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm(
                        "Run project-local agents?",
                        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                    );
                    if (!ok)
                        return {
                            content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                            details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                        };
                }
            }

            // ── Chain mode ─────────────────────────────────────────────
            if (params.chain && params.chain.length > 0) {
                const results: SingleResult[] = [];
                let previousOutput = "";

                for (let i = 0; i < params.chain.length; i++) {
                    const step = params.chain[i];
                    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

                    const chainUpdate: OnUpdateCallback | undefined = onUpdate
                        ? (partial) => {
                            const currentResult = partial.details?.results[0];
                            if (currentResult) {
                                const allResults = [...results, currentResult];
                                onUpdate({
                                    content: partial.content,
                                    details: makeDetails("chain")(allResults),
                                });
                            }
                        }
                        : undefined;

                    const result = await runSingleAgent(
                        ctx.cwd, agents, step.agent, taskWithContext,
                        step.cwd, i + 1, signal, chainUpdate, makeDetails("chain"),
                    );
                    results.push(result);

                    if (isFailed(result)) {
                        const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
                        return {
                            content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                            details: makeDetails("chain")(results),
                            isError: true,
                        };
                    }
                    previousOutput = getFinalOutput(result.messages);
                }
                return {
                    content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
                    details: makeDetails("chain")(results),
                };
            }

            // ── Parallel mode ──────────────────────────────────────────
            if (params.tasks && params.tasks.length > 0) {
                if (params.tasks.length > maxParallelTasks)
                    return {
                        content: [
                            { type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${maxParallelTasks}.` },
                        ],
                        details: makeDetails("parallel")([]),
                    };

                const allResults: SingleResult[] = new Array(params.tasks.length);
                for (let i = 0; i < params.tasks.length; i++) {
                    allResults[i] = {
                        agent: params.tasks[i].agent,
                        agentSource: "unknown",
                        task: params.tasks[i].task,
                        exitCode: -1,
                        messages: [],
                        stderr: "",
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                    };
                }

                const emitParallelUpdate = () => {
                    if (onUpdate) {
                        const running = allResults.filter((r) => r.exitCode === -1).length;
                        const done = allResults.filter((r) => r.exitCode !== -1).length;
                        onUpdate({
                            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
                            details: makeDetails("parallel")([...allResults]),
                        });
                    }
                };

                const results = await mapWithConcurrencyLimit(params.tasks, maxConcurrency, async (t, index) => {
                    const result = await runSingleAgent(
                        ctx.cwd, agents, t.agent, t.task, t.cwd, undefined, signal,
                        (partial) => {
                            if (partial.details?.results[0]) {
                                allResults[index] = partial.details.results[0];
                                emitParallelUpdate();
                            }
                        },
                        makeDetails("parallel"),
                    );
                    allResults[index] = result;
                    emitParallelUpdate();
                    return result;
                });

                const successCount = results.filter((r) => !isFailed(r)).length;
                const summaries = results.map((r) => {
                    const output = getFinalOutput(r.messages);
                    const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
                    return `[${r.agent}] ${isFailed(r) ? "failed" : "completed"}: ${preview || "(no output)"}`;
                });
                const hasFailures = results.some(isFailed);
                return {
                    content: [
                        { type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` },
                    ],
                    details: makeDetails("parallel")(results),
                    ...(hasFailures && { isError: true }),
                };
            }

            // ── Single mode ───────────────────────────────────────────
            if (params.agent && params.task) {
                const result = await runSingleAgent(
                    ctx.cwd, agents, params.agent, params.task,
                    params.cwd, undefined, signal, onUpdate, makeDetails("single"),
                );
                if (isFailed(result)) {
                    const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
                    return {
                        content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                        details: makeDetails("single")([result]),
                        isError: true,
                    };
                }
                return {
                    content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
                    details: makeDetails("single")([result]),
                };
            }

            // ── Fallback ───────────────────────────────────────────────
            const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
            return {
                content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
                details: makeDetails("single")([]),
            };
        },

        renderCall: renderSubagentCall,
        renderResult(result, opts, theme) {
            return renderSubagentResult(result, opts, theme);
        },
    });
};

// ── Re-exports for backward compatibility ─────────────────────────────
// All public symbols from submodules are re-exported so that existing callers
// importing from "./subagent.js" or "./subagent/index.js" continue to work.

export * from "./types.js";
export * from "./format.js";
export { runSingleAgent, resolveTools, mapWithConcurrencyLimit, BUILTIN_TOOLS } from "./engine.js";
export { renderSubagentCall, renderSubagentResult } from "./render.js";
