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

import * as os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
    type ExtensionAPI,
    getMarkdownTheme,
    createAgentSession,
    DefaultResourceLoader,
    codingTools,
    readOnlyTools,
    bashTool,
    readTool,
    editTool,
    writeTool,
    grepTool,
    findTool,
    lsTool,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents } from "./subagent-agents.js";
import { getPluginAgentPaths } from "./claude-plugins.js";
import { defaultAgentDir } from "../config.js";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// ── Usage formatting helpers ───────────────────────────────────────────

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens?: number;
        turns?: number;
    },
    model?: string,
): string {
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
    }
    if (model) parts.push(model);
    return parts.join(" ");
}

// ── Tool call formatting for TUI display ───────────────────────────────

function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: (color: any, text: string) => string,
): string {
    const shortenPath = (p: string) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };

    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const content = (args.content || "") as string;
            const lines = content.split("\n").length;
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
        }
        case "ls": {
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}

// ── Types ──────────────────────────────────────────────────────────────

export interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface SingleResult {
    agent: string;
    agentSource: "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
}

export interface SubagentDetails {
    mode: "single" | "parallel" | "chain";
    agentScope: AgentScope;
    projectAgentsDir: string | null;
    results: SingleResult[];
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Shared predicate for determining if a subagent result represents a failure. */
function isFailed(r: SingleResult): boolean {
    return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
    items: TIn[],
    concurrency: number,
    fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
    if (items.length === 0) return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results: TOut[] = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length) return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}

// ── Execution engine ───────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Map of all built-in tool names → tool objects. */
const BUILTIN_TOOLS: Record<string, (typeof codingTools)[number]> = {
    bash: bashTool,
    read: readTool,
    edit: editTool,
    write: writeTool,
    grep: grepTool,
    find: findTool,
    ls: lsTool,
};

/**
 * Resolve agent tool names to actual Tool objects from the built-in set.
 * Returns null if any requested tool name is unknown (fail-closed).
 */
function resolveTools(toolNames: string[]): { tools: (typeof codingTools)[number][] } | { error: string } {
    const resolved: (typeof codingTools)[number][] = [];
    const unknown: string[] = [];
    for (const name of toolNames) {
        if (BUILTIN_TOOLS[name]) resolved.push(BUILTIN_TOOLS[name]);
        else unknown.push(name);
    }
    if (unknown.length > 0) {
        const available = Object.keys(BUILTIN_TOOLS).join(", ");
        return { error: `Unknown tool(s): ${unknown.join(", ")}. Available: ${available}` };
    }
    if (resolved.length === 0) {
        return { error: "No tools specified. Use at least one built-in tool." };
    }
    return { tools: resolved };
}

async function runSingleAgent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
    const agent = agents.find((a) => a.name === agentName);

    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
        };
    }

    // Resolve effective tools — apply disallowedTools filtering to both explicit and default toolsets
    let effectiveToolNames: string[] | undefined;
    if (agent.tools && agent.tools.length > 0) {
        effectiveToolNames = [...agent.tools];
    }
    // Apply disallowedTools to whichever toolset is active (explicit or default)
    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
        const denied = new Set(agent.disallowedTools);
        if (effectiveToolNames) {
            effectiveToolNames = effectiveToolNames.filter(t => !denied.has(t));
        } else {
            // Apply disallowedTools to the default coding tools
            effectiveToolNames = Object.keys(BUILTIN_TOOLS).filter(t => !denied.has(t));
        }
    }

    const maxTurns = agent.maxTurns && agent.maxTurns > 0 ? agent.maxTurns : 0;

    const currentResult: SingleResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: -1, // -1 = running; set to 0 on success, 1 on failure after prompt completes
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: undefined, // Will be set from actual assistant message model
        step,
    };

    const emitUpdate = () => {
        if (onUpdate) {
            onUpdate({
                content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
                details: makeDetails([currentResult]),
            });
        }
    };

    try {
        // Honor permissionMode from agent frontmatter.
        // "plan" → read-only tools (no writes/edits/bash)
        // "dontAsk" / "bypassPermissions" → default (all tools, no confirmation — already the case)
        // "default" / "acceptEdits" / unset → default behavior
        const isPlanMode = agent.permissionMode === "plan";

        // Build session options — resolve tools fail-closed
        let tools: (typeof codingTools)[number][];
        if (isPlanMode) {
            // Plan mode: restrict to read-only tools regardless of agent config
            tools = [...readOnlyTools];
        } else if (effectiveToolNames) {
            const resolved = resolveTools(effectiveToolNames);
            if ("error" in resolved) {
                return {
                    agent: agentName,
                    agentSource: agent.source,
                    task,
                    exitCode: 1,
                    messages: [],
                    stderr: resolved.error,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                    step,
                };
            }
            tools = resolved.tools;
        } else {
            tools = [...codingTools];
        }
        const sessionCwd = cwd ?? defaultCwd;

        // Use a lightweight resource loader — no extensions, skills, themes, etc.
        // Just the system prompt from the agent definition.
        const loader = new DefaultResourceLoader({
            cwd: sessionCwd,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            ...(agent.systemPrompt.trim() && { appendSystemPrompt: agent.systemPrompt }),
        });
        await loader.reload();

        const { session } = await createAgentSession({
            cwd: sessionCwd,
            agentDir: defaultAgentDir(),
            tools,
            resourceLoader: loader,
        });

        // Subscribe to events to track messages and usage
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end" && "message" in event) {
                const msg = event.message as Message;
                currentResult.messages.push(msg);

                if (msg.role === "assistant") {
                    currentResult.usage.turns++;
                    const assistantMsg = msg as AssistantMessage;
                    const usage = assistantMsg.usage;
                    if (usage) {
                        currentResult.usage.input += usage.input || 0;
                        currentResult.usage.output += usage.output || 0;
                        currentResult.usage.cacheRead += usage.cacheRead || 0;
                        currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                        currentResult.usage.cost += (usage.cost as any)?.total || 0;
                        currentResult.usage.contextTokens = usage.totalTokens || 0;
                    }
                    if (!currentResult.model && assistantMsg.model) currentResult.model = assistantMsg.model;
                    if (assistantMsg.stopReason) currentResult.stopReason = assistantMsg.stopReason;
                    if (assistantMsg.errorMessage) currentResult.errorMessage = assistantMsg.errorMessage;

                    // Enforce maxTurns — use session.abort() to actually stop the session
                    if (maxTurns > 0 && currentResult.usage.turns >= maxTurns) {
                        currentResult.stderr += `\n[subagent] maxTurns limit reached (${maxTurns}), stopping.`;
                        session.abort().catch(() => {});
                    }
                }
                emitUpdate();
            }

            // Capture tool results from turn_end events
            if (event.type === "turn_end" && "toolResults" in event) {
                const toolResults = (event as any).toolResults;
                if (Array.isArray(toolResults)) {
                    for (const tr of toolResults) {
                        currentResult.messages.push(tr as Message);
                    }
                }
                emitUpdate();
            }
        });

        // Handle external abort signal — use session.abort() for real cancellation
        if (signal?.aborted) throw new Error("Subagent was aborted");
        const onAbort = () => { session.abort().catch(() => {}); };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            // Run the prompt
            await session.prompt(`Task: ${task}`);
            // Mark as successfully completed
            currentResult.exitCode = 0;
        } catch (err) {
            if (signal?.aborted) throw new Error("Subagent was aborted");
            currentResult.exitCode = 1;
            currentResult.stderr += `\n${err instanceof Error ? err.message : String(err)}`;
        } finally {
            signal?.removeEventListener("abort", onAbort);
            // Clean up session resources to prevent leaks across repeated calls
            unsubscribe();
            session.dispose();
        }

        return currentResult;
    } catch (err) {
        if (String(err).includes("aborted")) throw err;
        currentResult.exitCode = 1;
        currentResult.stderr += `\nFailed to create subagent session: ${err instanceof Error ? err.message : String(err)}`;
        return currentResult;
    }
}

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
                    .filter((a): a is AgentConfig => a?.source === "project");

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
                if (params.tasks.length > MAX_PARALLEL_TASKS)
                    return {
                        content: [
                            { type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
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

                const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
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

        // ── TUI rendering ──────────────────────────────────────────────

        renderCall(args, theme) {
            const scope: AgentScope = args.agentScope ?? "user";
            if (args.chain && args.chain.length > 0) {
                let text =
                    theme.fg("toolTitle", theme.bold("subagent ")) +
                    theme.fg("accent", `chain (${args.chain.length} steps)`) +
                    theme.fg("muted", ` [${scope}]`);
                for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
                    const step = args.chain[i];
                    const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
                    const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
                    text +=
                        "\n  " +
                        theme.fg("muted", `${i + 1}.`) + " " +
                        theme.fg("accent", step.agent) +
                        theme.fg("dim", ` ${preview}`);
                }
                if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
                return new Text(text, 0, 0);
            }
            if (args.tasks && args.tasks.length > 0) {
                let text =
                    theme.fg("toolTitle", theme.bold("subagent ")) +
                    theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
                    theme.fg("muted", ` [${scope}]`);
                for (const t of args.tasks.slice(0, 3)) {
                    const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
                    text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
                }
                if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
                return new Text(text, 0, 0);
            }
            const agentName = args.agent || "...";
            const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
            let text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("accent", agentName) +
                theme.fg("muted", ` [${scope}]`);
            text += `\n  ${theme.fg("dim", preview)}`;
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as SubagentDetails | undefined;
            if (!details || details.results.length === 0) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
            }

            const mdTheme = getMarkdownTheme();

            const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
                const toShow = limit ? items.slice(-limit) : items;
                const skipped = limit && items.length > limit ? items.length - limit : 0;
                let text = "";
                if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
                for (const item of toShow) {
                    if (item.type === "text") {
                        const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
                        text += `${theme.fg("toolOutput", preview)}\n`;
                    } else {
                        text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
                    }
                }
                return text.trimEnd();
            };

            // ── Single result rendering ────────────────────────────────
            if (details.mode === "single" && details.results.length === 1) {
                const r = details.results[0];
                const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
                const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                const displayItems = getDisplayItems(r.messages);
                const finalOutput = getFinalOutput(r.messages);

                if (expanded) {
                    const container = new Container();
                    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
                    if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                    container.addChild(new Text(header, 0, 0));
                    if (isError && r.errorMessage)
                        container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
                    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
                    if (displayItems.length === 0 && !finalOutput) {
                        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
                    } else {
                        for (const item of displayItems) {
                            if (item.type === "toolCall")
                                container.addChild(
                                    new Text(
                                        theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                        0, 0,
                                    ),
                                );
                        }
                        if (finalOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                        }
                    }
                    const usageStr = formatUsageStats(r.usage, r.model);
                    if (usageStr) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
                    }
                    return container;
                }

                // Collapsed single view
                let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
                if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
                else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
                else {
                    text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
                    if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                }
                const usageStr = formatUsageStats(r.usage, r.model);
                if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
                return new Text(text, 0, 0);
            }

            // ── Aggregate usage helper ─────────────────────────────────
            const aggregateUsage = (results: SingleResult[]) => {
                const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
                for (const r of results) {
                    total.input += r.usage.input;
                    total.output += r.usage.output;
                    total.cacheRead += r.usage.cacheRead;
                    total.cacheWrite += r.usage.cacheWrite;
                    total.cost += r.usage.cost;
                    total.turns += r.usage.turns;
                }
                return total;
            };

            // ── Chain result rendering ─────────────────────────────────
            if (details.mode === "chain") {
                const successCount = details.results.filter((r) => r.exitCode === 0).length;
                const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

                if (expanded) {
                    const container = new Container();
                    container.addChild(
                        new Text(
                            icon + " " +
                            theme.fg("toolTitle", theme.bold("chain ")) +
                            theme.fg("accent", `${successCount}/${details.results.length} steps`),
                            0, 0,
                        ),
                    );

                    for (const r of details.results) {
                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                        const displayItems = getDisplayItems(r.messages);
                        const finalOutput = getFinalOutput(r.messages);

                        container.addChild(new Spacer(1));
                        container.addChild(
                            new Text(`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
                        );
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                        for (const item of displayItems) {
                            if (item.type === "toolCall") {
                                container.addChild(
                                    new Text(
                                        theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                        0, 0,
                                    ),
                                );
                            }
                        }

                        if (finalOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                        }

                        const stepUsage = formatUsageStats(r.usage, r.model);
                        if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results));
                    if (usageStr) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
                    }
                    return container;
                }

                // Collapsed chain view
                let text =
                    icon + " " +
                    theme.fg("toolTitle", theme.bold("chain ")) +
                    theme.fg("accent", `${successCount}/${details.results.length} steps`);
                for (const r of details.results) {
                    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                    const displayItems = getDisplayItems(r.messages);
                    text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
                    if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
                    else text += `\n${renderDisplayItems(displayItems, 5)}`;
                }
                const usageStr = formatUsageStats(aggregateUsage(details.results));
                if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
                text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                return new Text(text, 0, 0);
            }

            // ── Parallel result rendering ──────────────────────────────
            if (details.mode === "parallel") {
                const running = details.results.filter((r) => r.exitCode === -1).length;
                const successCount = details.results.filter((r) => r.exitCode === 0).length;
                const failCount = details.results.filter((r) => r.exitCode > 0).length;
                const isRunning = running > 0;
                const icon = isRunning
                    ? theme.fg("warning", "⏳")
                    : failCount > 0
                        ? theme.fg("warning", "◐")
                        : theme.fg("success", "✓");
                const status = isRunning
                    ? `${successCount + failCount}/${details.results.length} done, ${running} running`
                    : `${successCount}/${details.results.length} tasks`;

                if (expanded && !isRunning) {
                    const container = new Container();
                    container.addChild(
                        new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
                    );

                    for (const r of details.results) {
                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                        const displayItems = getDisplayItems(r.messages);
                        const finalOutput = getFinalOutput(r.messages);

                        container.addChild(new Spacer(1));
                        container.addChild(
                            new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
                        );
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                        for (const item of displayItems) {
                            if (item.type === "toolCall") {
                                container.addChild(
                                    new Text(
                                        theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                        0, 0,
                                    ),
                                );
                            }
                        }

                        if (finalOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                        }

                        const taskUsage = formatUsageStats(r.usage, r.model);
                        if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results));
                    if (usageStr) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
                    }
                    return container;
                }

                // Collapsed parallel view (or still running)
                let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
                for (const r of details.results) {
                    const rIcon =
                        r.exitCode === -1
                            ? theme.fg("warning", "⏳")
                            : r.exitCode === 0
                                ? theme.fg("success", "✓")
                                : theme.fg("error", "✗");
                    const displayItems = getDisplayItems(r.messages);
                    text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
                    if (displayItems.length === 0)
                        text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
                    else text += `\n${renderDisplayItems(displayItems, 5)}`;
                }
                if (!isRunning) {
                    const usageStr = formatUsageStats(aggregateUsage(details.results));
                    if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
                }
                if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                return new Text(text, 0, 0);
            }

            // Fallback
            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        },
    });
};
