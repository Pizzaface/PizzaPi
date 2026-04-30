/**
 * Agent execution engine for the subagent tool.
 *
 * Handles tool resolution, concurrency-limited parallel execution,
 * and the core single-agent runner (createAgentSession + session.prompt).
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    createCodingTools,
    createReadOnlyTools,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../subagent-agents.js";
import type { Model } from "@mariozechner/pi-ai";
import { defaultAgentDir } from "../../config.js";
import type { SingleResult, SubagentDetails, OnUpdateCallback } from "./types.js";
import { getFinalOutput, summarizeResultForStreaming } from "./types.js";

// ── Built-in tool registry ─────────────────────────────────────────────

export const BUILTIN_TOOLS = {
    bash: true,
    read: true,
    edit: true,
    write: true,
    grep: true,
    find: true,
    ls: true,
} as const;

/**
 * Resolve agent tool names to built-in tool names.
 * Returns null if any requested tool name is unknown (fail-closed).
 */
export function resolveTools(toolNames: string[]): { tools: string[] } | { error: string } {
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const name of toolNames) {
        if (name in BUILTIN_TOOLS) resolved.push(name);
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

// ── Concurrency utility ────────────────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
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

// ── Single-agent runner ────────────────────────────────────────────────

export interface ModelOverride {
    provider: string;
    id: string;
}

// ── Model resolution helpers ───────────────────────────────────────────

/** Common model shorthand aliases. */
const MODEL_ALIASES: Record<string, { provider: string; id: string }> = {
    haiku: { provider: "anthropic", id: "claude-haiku-4-5" },
    sonnet: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    opus: { provider: "anthropic", id: "claude-opus-4-5" },
};

/**
 * Parse a model string from agent frontmatter into a {provider, id} pair.
 *
 * Accepts:
 *   - Shorthand aliases: "haiku", "sonnet", "opus" → resolves to Anthropic model IDs
 *   - Provider/id format: "anthropic/claude-haiku-4-5" → { provider: "anthropic", id: "claude-haiku-4-5" }
 *   - Bare model ID (assumes Anthropic): "claude-haiku-4-5" → { provider: "anthropic", id: "claude-haiku-4-5" }
 *   - "inherit" or empty string → undefined (use default)
 */
export function parseModelString(model: string): ModelOverride | undefined {
    const trimmed = model.trim();
    if (!trimmed || trimmed === "inherit") return undefined;

    // Check alias map first
    const alias = MODEL_ALIASES[trimmed.toLowerCase()];
    if (alias) return alias;

    // provider/id format
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0) {
        return { provider: trimmed.slice(0, slashIdx), id: trimmed.slice(slashIdx + 1) };
    }

    // Bare model ID — assume anthropic
    return { provider: "anthropic", id: trimmed };
}

/** Narrow interface for the model registry — only what the engine needs. */
export interface ModelRegistryLike {
    find: (provider: string, modelId: string) => Model<any> | undefined;
    getAvailable: () => Model<any>[];
}

/**
 * Select the cheapest available model from the registry.
 *
 * When no model is explicitly specified (neither by the caller nor the agent
 * frontmatter), subagents should use the most cost-effective model rather
 * than inheriting the parent's (potentially expensive) default.
 *
 * Selection strategy:
 *   1. Among available models, sort by output costascending.
 *   2. Pick the cheapest model that has credentials configured.
 *   3. If no available models, return undefined (fall back to default).
 */
export function selectLightweightModel(registry: ModelRegistryLike): Model<any> | undefined {
    const available = registry.getAvailable();
    if (available.length === 0) return undefined;

    // Sort by output token cost ascending — cheapest first
    const sorted = [...available].sort((a, b) => a.cost.output - b.cost.output);
    return sorted[0];
}

export async function runSingleAgent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
    modelOverride?: ModelOverride,
    modelRegistry?: ModelRegistryLike,
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
            const summary = summarizeResultForStreaming(currentResult);
            onUpdate({
                content: [{ type: "text", text: summary.latestOutput || "(running...)" }],
                details: makeDetails([summary]),
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
        const sessionCwd = cwd ?? defaultCwd;
        let tools: string[];
        if (isPlanMode) {
            // Plan mode: restrict to read-only tools regardless of agent config
            tools = createReadOnlyTools(sessionCwd).map((tool) => tool.name);
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
            tools = createCodingTools(sessionCwd).map((tool) => tool.name);
        }

        // Use a lightweight resource loader — no extensions, skills, themes, etc.
        // Just the system prompt from the agent definition.
        const loader = new DefaultResourceLoader({
            cwd: sessionCwd,
            agentDir: defaultAgentDir(),
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            ...(agent.systemPrompt.trim() && { appendSystemPrompt: [agent.systemPrompt] }),
        });
        await loader.reload();

        // Resolve model: tool parameter > agent frontmatter > auto-select cheapest > inherit parent default
        let resolvedModel: Model<any> | undefined;
        const modelSpec = modelOverride ?? (agent.model ? parseModelString(agent.model) : undefined);
        if (modelSpec && modelRegistry) {
            // Explicit model specified — look it up
            resolvedModel = modelRegistry.find(modelSpec.provider, modelSpec.id);
            if (!resolvedModel) {
                currentResult.exitCode = 1;
                currentResult.stderr = `Model not found: ${modelSpec.provider}/${modelSpec.id}. Use the \`models\` command to see available models.`;
                return currentResult;
            }
        } else if (modelRegistry) {
            // No explicit model — auto-select the cheapest available model
            resolvedModel = selectLightweightModel(modelRegistry);
            // If no available models at all, resolvedModel stays undefined and
            // createAgentSession will fall back to its own default selection.
        }

        const { session } = await createAgentSession({
            cwd: sessionCwd,
            agentDir: defaultAgentDir(),
            tools,
            resourceLoader: loader,
            ...(resolvedModel && { model: resolvedModel }),
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
            if (typeof (session as { dispose?: () => void }).dispose === "function") {
                session.dispose();
            }
        }

        return currentResult;
    } catch (err) {
        if (String(err).includes("aborted")) throw err;
        currentResult.exitCode = 1;
        currentResult.stderr += `\nFailed to create subagent session: ${err instanceof Error ? err.message : String(err)}`;
        return currentResult;
    }
}
