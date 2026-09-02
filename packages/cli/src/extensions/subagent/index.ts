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
 * zero-overhead execution. Tool calls return immediately; completed results
 * are injected into the supervisor session as follow-up messages.
 *
 * Adapted from upstream pi subagent extension (examples/extensions/subagent/)
 * with PizzaPi-specific agent discovery paths (~/.pizzapi/agents/,
 * ~/.claude/agents/, .pizzapi/agents/, .claude/agents/) and structured
 * `details` payloads for web UI consumption.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentScope, discoverAgents } from "../subagent-agents.js";
import { getPluginAgentPaths } from "../claude-plugins.js";
import { loadGlobalConfig, resolveAgentDir, resolveExplicitProjectTrust } from "../../config.js";
import { collectOverlayAgentDirs } from "../../overlay/session-packages.js";
import {
    DEFAULT_MAX_PARALLEL_TASKS,
    DEFAULT_MAX_CONCURRENCY,
    PARALLEL_SPILL_THRESHOLD,
    toFinitePositiveInt,
    isFailed,
    getFinalOutput,
    sanitizeAgentFileSegment,
    shouldSpillParallelOutput,
    summarizeResultForStreaming,
    summarizeResultsForStreaming,
    type SubagentDetails,
    type SingleResult,
} from "./types.js";
import { runSingleAgent, mapWithConcurrencyLimit } from "./engine.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { reserveSubagentSlots, resetSubagentState, resetSubagentCounters } from "./background-state.js";

// ── Tool parameter schemas (JSON Schema) ───────────────────────────────

const ModelSchema = {
    type: "object",
    description: "Model override for the subagent session. If omitted, uses the agent definition's model or falls back to the default model.",
    properties: {
        provider: { type: "string", description: "Model provider (e.g., 'anthropic', 'google', 'openai')" },
        id: { type: "string", description: "Model ID (e.g., 'claude-haiku-4-5', 'gemini-2.5-pro')" },
    },
    required: ["provider", "id"],
} as const;

const TaskItemSchema = {
    type: "object",
    properties: {
        agent: { type: "string", description: "Name of the agent to invoke" },
        task: { type: "string", description: "Task to delegate to the agent" },
        cwd: { type: "string", description: "Working directory for the agent process" },
        model: ModelSchema,
    },
    required: ["agent", "task"],
} as const;

const ChainItemSchema = {
    type: "object",
    properties: {
        agent: { type: "string", description: "Name of the agent to invoke" },
        task: { type: "string", description: "Task with optional {previous} placeholder for prior output" },
        cwd: { type: "string", description: "Working directory for the agent process" },
        model: ModelSchema,
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
        model: ModelSchema,
    },
} as const;

// ── Extension factory ──────────────────────────────────────────────────

export const subagentExtension = (pi: ExtensionAPI, runAgent = runSingleAgent) => {
    const backgroundTasks = new Map<AbortController, Promise<void>>();

    // Abort every in-flight background subagent and wait for their finally
    // blocks to release slots + end their relay mirror. `preserveListeners`
    // keeps the lifecycle onSubagentsIdle listener alive across `/new`.
    const abortAll = async (preserveListeners: boolean) => {
        for (const controller of backgroundTasks.keys()) controller.abort();
        await Promise.allSettled(backgroundTasks.values());
        backgroundTasks.clear();
        if (preserveListeners) resetSubagentCounters();
        else resetSubagentState();
    };

    pi.on("session_shutdown", async () => { await abortAll(false); });

    // `/new` resets the conversation in place: an aborted subagent's result
    // (and its lingering mirror session) must not bleed into the new one, and a
    // still-reserved slot would otherwise leave the fresh conversation looking
    // "never settled" (hasActiveSubagents stays true across the reset).
    pi.on("session_switch" as any, async (event: any) => {
        if (event?.reason === "new") await abortAll(true);
    });

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Subagents run in the background; this tool returns immediately and automatically sends their results as a follow-up when done.",
            "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
            'Default agent scope is "user" (from ~/.pizzapi/agents and ~/.claude/agents).',
            'To enable project-local agents in .pizzapi/agents or .claude/agents, set agentScope: "both" (or "project").',
            "Set `model: { provider, id }` to override the model for the subagent session (recommended: use haiku for most tasks).",
            "Compatible with Claude Code agent definition files.",
        ].join(" "),
        parameters: SubagentParams as any,

        async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
            // Read concurrency limits from global config only — project-local
            // config must not be able to raise fan-out limits for untrusted repos.
            const globalConfig = loadGlobalConfig();
            const maxParallelTasks = toFinitePositiveInt(globalConfig.subagent?.maxParallelTasks, DEFAULT_MAX_PARALLEL_TASKS);
            const maxConcurrency = toFinitePositiveInt(globalConfig.subagent?.maxConcurrency, DEFAULT_MAX_CONCURRENCY);

            const params = (rawParams ?? {}) as {
                agent?: string;
                task?: string;
                tasks?: Array<{ agent: string; task: string; cwd?: string; model?: { provider: string; id: string } }>;
                chain?: Array<{ agent: string; task: string; cwd?: string; model?: { provider: string; id: string } }>;
                agentScope?: AgentScope;
                confirmProjectAgents?: boolean;
                cwd?: string;
                model?: { provider: string; id: string };
            };
            const agentScope: AgentScope = params.agentScope ?? "user";
            const pluginAgentDirs = getPluginAgentPaths(ctx.cwd);
            // Package-origin agent dirs win legacy plugin-dir name collisions,
            // matching the package-over-legacy precedence used elsewhere in the
            // overlay (docs/specs/pi-pizzapi-overlay.md §8) — listed first so
            // discoverAgents' first-name-wins merge prefers them.
            const overlayAgentDir = resolveAgentDir(ctx.cwd);
            const overlayProjectTrusted = resolveExplicitProjectTrust(ctx.cwd, overlayAgentDir);
            const overlayAgentDirs = collectOverlayAgentDirs(ctx.cwd, overlayAgentDir, overlayProjectTrusted);
            const discovery = discoverAgents(ctx.cwd, agentScope, {
                extraUserDirs: [...overlayAgentDirs.userDirs, ...pluginAgentDirs],
                extraProjectDirs: overlayAgentDirs.projectDirs,
                extraUserFiles: overlayAgentDirs.userFiles,
                extraProjectFiles: overlayAgentDirs.projectFiles,
            });
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

            const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
            if (params.tasks && params.tasks.length > maxParallelTasks) {
                return {
                    content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${maxParallelTasks}.` }],
                    details: makeDetails("parallel")([]),
                    isError: true,
                };
            }

            if (signal?.aborted) {
                return {
                    content: [{ type: "text", text: "Subagent launch canceled." }],
                    details: makeDetails(mode)([]),
                    isError: true,
                };
            }

            const slotCount = params.tasks?.length ?? 1;
            const releaseSlots = reserveSubagentSlots(slotCount, maxParallelTasks);
            if (!releaseSlots) {
                return {
                    content: [{ type: "text", text: `Too many active subagents. Max is ${maxParallelTasks}.` }],
                    details: makeDetails(mode)([]),
                    isError: true,
                };
            }

            const taskId = randomUUID();
            const controller = new AbortController();
            const onTurnAbort = () => controller.abort();
            signal?.addEventListener("abort", onTurnAbort, { once: true });

            const run = async () => {
                // ── Chain mode ─────────────────────────────────────────
                if (params.chain && params.chain.length > 0) {
                    const results: SingleResult[] = [];
                    let previousOutput = "";

                    for (let i = 0; i < params.chain.length; i++) {
                        const step = params.chain[i];
                        const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

                        const result = await runAgent(
                            ctx.cwd, agents, step.agent, taskWithContext,
                            step.cwd, i + 1, controller.signal, undefined, makeDetails("chain"),
                            step.model ?? params.model, ctx.modelRegistry,
                        );
                        results.push(result);

                        if (isFailed(result)) {
                            const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
                            return {
                                content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                                details: makeDetails("chain")(summarizeResultsForStreaming(results)),
                                isError: true,
                            };
                        }
                        previousOutput = getFinalOutput(result.messages);
                    }
                    return {
                        content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
                        details: makeDetails("chain")(summarizeResultsForStreaming(results)),
                    };
                }

            // ── Parallel mode ──────────────────────────────────────────
            if (params.tasks && params.tasks.length > 0) {
                const results = await mapWithConcurrencyLimit(params.tasks, maxConcurrency, async (t) => {
                    const result = await runAgent(
                        ctx.cwd, agents, t.agent, t.task, t.cwd, undefined, controller.signal,
                        undefined,
                        makeDetails("parallel"),
                        t.model ?? params.model, ctx.modelRegistry,
                    );
                    return result;
                });

                const successCount = results.filter((r) => !isFailed(r)).length;
                const hasFailures = results.some(isFailed);

                // Build full output per task
                const sections = results.map((r) => {
                    const output = getFinalOutput(r.messages);
                    const status = isFailed(r) ? "failed" : "completed";
                    return `## [${r.agent}] ${status}\n\n${output || "(no output)"}`;
                });
                const fullText = `Parallel: ${successCount}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;

                // If combined output is very large, spill each task's output to a temp file
                // so the LLM can selectively read what it needs without blowing up context
                let contentText: string;
                if (shouldSpillParallelOutput(fullText)) {
                    const spillDir = mkdtempSync(join(tmpdir(), "subagent-parallel-"));
                    const fileSummaries = results.map((r, i) => {
                        const output = getFinalOutput(r.messages);
                        const status = isFailed(r) ? "failed" : "completed";
                        const filePath = join(spillDir, `${i}-${sanitizeAgentFileSegment(r.agent)}.md`);
                        writeFileSync(filePath, `# [${r.agent}] ${status}\n\nTask: ${r.task}\n\n${output || "(no output)"}`);
                        const preview = output.slice(0, 200) + (output.length > 200 ? "..." : "");
                        return `[${r.agent}] ${status} (${output.length} chars) → ${filePath}\n${preview}`;
                    });
                    contentText = `Parallel: ${successCount}/${results.length} succeeded\n\nOutputs exceeded ${Math.round(PARALLEL_SPILL_THRESHOLD / 1024)}KB — full results saved to temp files. Use \`read\` to access them.\n\n${fileSummaries.join("\n\n")}`;
                } else {
                    contentText = fullText;
                }

                return {
                    content: [{ type: "text", text: contentText }],
                    details: makeDetails("parallel")(summarizeResultsForStreaming(results)),
                    ...(hasFailures && { isError: true }),
                };
            }

            // ── Single mode ───────────────────────────────────────────
            if (params.agent && params.task) {
                const result = await runAgent(
                    ctx.cwd, agents, params.agent, params.task,
                    params.cwd, undefined, controller.signal, undefined, makeDetails("single"),
                    params.model, ctx.modelRegistry,
                );
                if (isFailed(result)) {
                    const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
                    return {
                        content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                        details: makeDetails("single")([summarizeResultForStreaming(result)]),
                        isError: true,
                    };
                }
                return {
                    content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
                    details: makeDetails("single")([summarizeResultForStreaming(result)]),
                };
            }

            // ── Fallback ───────────────────────────────────────────────
            const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
            return {
                content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
                details: makeDetails("single")([]),
            };
            };

            const deliver = (message: string, details?: SubagentDetails): boolean => {
                try {
                    pi.sendMessage({
                        customType: "subagent-result",
                        content: message,
                        display: true,
                        details: { taskId, ...details },
                    }, { deliverAs: "followUp", triggerTurn: true });
                    return true;
                } catch (err) {
                    console.error(`Failed to deliver subagent ${taskId} result:`, err);
                    return false;
                }
            };
            let deliveryStarted = false;
            const task = run()
                .then((result) => {
                    if (controller.signal.aborted) return;
                    const text = result.content
                        .filter((part): part is { type: "text"; text: string } => part.type === "text")
                        .map((part) => part.text)
                        .join("\n");
                    deliveryStarted = deliver(
                        `[Subagent ${taskId} ${result.isError ? "failed" : "completed"}]\n\n${text || "(no output)"}`,
                        result.details,
                    );
                }, (err) => {
                    if (controller.signal.aborted) return;
                    const message = err instanceof Error ? err.message : String(err);
                    deliveryStarted = deliver(`[Subagent ${taskId} failed]\n\n${message}`);
                })
                .finally(() => {
                    signal?.removeEventListener("abort", onTurnAbort);
                    backgroundTasks.delete(controller);
                    releaseSlots(deliveryStarted);
                });
            backgroundTasks.set(controller, task);

            return {
                content: [{
                    type: "text",
                    text: `Subagent ${taskId} is running in the background. Continue working; its result will arrive automatically when done.`,
                }],
                details: {
                    ...makeDetails(mode)([]),
                    background: { taskId, status: "started" as const },
                },
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
export { runSingleAgent, resolveTools, mapWithConcurrencyLimit, BUILTIN_TOOLS, parseModelString, resolveModelSpec, selectLightweightModel, type ModelOverride, type ModelRegistryLike } from "./engine.js";
export { renderSubagentCall, renderSubagentResult } from "./render.js";
