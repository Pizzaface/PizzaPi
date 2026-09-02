/**
 * Agent execution engine for the subagent tool.
 *
 * Handles tool resolution, concurrency-limited parallel execution,
 * and the core single-agent runner (createAgentSession + session.prompt).
 */

import type { AgentConfig } from "../subagent-agents.js";
import type { Model, AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    createAgentSession,
    DefaultResourceLoader,
    createCodingTools,
    createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";
import { defaultAgentDir } from "../../config.js";
import { findCachedOllamaCloudModel } from "../../ollama-cloud-models.js";
import { isModelHidden } from "../../hidden-models.js";
import { getSubagentDefaultModelKey } from "../../subagent-default-model.js";
import type { SingleResult, SubagentDetails, OnUpdateCallback } from "./types.js";
import { summarizeResultForStreaming } from "./types.js";
import { createSubagentMirror, type SubagentMirror } from "./relay-mirror.js";

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
    const results: TOut[] = Array(items.length);
    let nextIndex = 0;
    const workers = Array(limit).fill(null).map(async () => {
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
 * True when the registry is a real ModelRegistry (safe to hand to
 * createAgentSession for auth resolution), not a narrow test mock.
 */
function isFullModelRegistry(registry: ModelRegistryLike): registry is ModelRegistryLike & import("@earendil-works/pi-coding-agent").ModelRegistry {
    return typeof (registry as { getApiKeyForProvider?: unknown }).getApiKeyForProvider === "function";
}

/** Extract the live ModelRuntime from a real ModelRegistry facade. */
function getModelRuntime(registry: ModelRegistryLike): ModelRuntime | undefined {
    if (!isFullModelRegistry(registry)) return undefined;
    // The upstream ModelRegistry class wraps a private `runtime` field;
    // at runtime it is an ordinary public property on the compiled class.
    return (registry as unknown as { runtime?: ModelRuntime }).runtime;
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
    const available = registry.getAvailable().filter((m) => !isModelHidden(m.provider, m.id));
    if (available.length === 0) return undefined;

    // User-configured default (web UI → Settings → Model Visibility) wins.
    // Resolved via resolveModelSpec so provider aliasing (anthropic ↔
    // claude-subscription) works; falls through to auto-pick when the
    // configured model isn't available on this runner.
    const configured = getSubagentDefaultModelKey();
    if (configured) {
        const spec = parseModelString(configured);
        if (spec) {
            const resolved = resolveModelSpec(spec, registry);
            if (resolved) return resolved;
        }
    }

    // Never auto-pick Google models — the free-tier "cheapest" entries (gemma
    // etc.) rate-limit and refuse almost immediately, silently breaking
    // subagent/workflow fan-out that didn't pin an explicit model.
    const eligible = available.filter((m) => !/google/i.test(m.provider) && !/^gem(ini|ma)/i.test(m.id));
    const pool = eligible.length > 0 ? eligible : available;

    // Sort by output token cost ascending — cheapest first
    const sorted = [...pool].sort((a, b) => a.cost.output - b.cost.output);
    return sorted[0];
}

/**
 * Resolve an explicit model spec against the registry.
 *
 * Falls back through:
 *   1. Exact provider/id match — but only if it has credentials configured
 *   2. Cached Ollama Cloud catalog (dynamic models not in the static registry)
 *   3. Same model id under a different available provider — e.g. the
 *      claude-subscription extension registers the same model ids under its
 *      own provider while the built-in "anthropic" catalog has no API key, so
 *      "anthropic/claude-haiku-4-5" resolves to
 *      "claude-subscription/claude-haiku-4-5".
 *   4. The credential-less exact match, so the downstream auth error names
 *      the provider the caller actually asked for.
 */
export function resolveModelSpec(spec: ModelOverride, registry: ModelRegistryLike): Model<any> | undefined {
    // Hidden models are hard-blocked by name everywhere (spawn route, model
    // switching) — subagents included.
    if (isModelHidden(spec.provider, spec.id)) return undefined;
    const exact = registry.find(spec.provider, spec.id);
    const available = registry.getAvailable();
    if (exact && available.includes(exact)) return exact;
    return (
        findCachedOllamaCloudModel(spec.provider, spec.id) ??
        // ponytail: same-id fallback only, no fuzzy matching
        available.find((m) => m.id === spec.id && !isModelHidden(m.provider, m.id)) ??
        exact
    );
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
    /** Mirror the run as a relay child session. Off for bulk fan-out callers
     *  (workflows render their own progress card and can run 1000 agents). */
    mirrorToRelay = true,
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

    // Do not create relay listeners or an AgentSession for work already cancelled.
    if (signal?.aborted) throw new Error("Subagent was aborted");

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

    // Mirror the run as an ephemeral relay child session so it shows up in the
    // sidebar next to spawn_session children. Null when the relay is off.
    let mirror: SubagentMirror | null = null;

    const emitUpdate = () => {
        mirror?.update(currentResult);
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
        if (mirrorToRelay) mirror = createSubagentMirror({ agentName, task, cwd: sessionCwd, step });
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
        if (signal?.aborted) throw new Error("Subagent was aborted");

        // Resolve model: tool parameter > agent frontmatter > auto-select cheapest > inherit parent default
        let resolvedModel: Model<any> | undefined;
        const modelSpec = modelOverride ?? (agent.model ? parseModelString(agent.model) : undefined);
        if (modelSpec && modelRegistry) {
            // Explicit model specified — look it up (with same-id provider
            // fallback for cases like claude-subscription replacing anthropic).
            resolvedModel = resolveModelSpec(modelSpec, modelRegistry);
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
            // Reuse the parent's live ModelRuntime so OAuth/subscription
            // providers (which keep tokens in memory, not in auth.json) work.
            // createAgentSession reads credentials from modelRuntime; the
            // modelRegistry facade alone is ignored by the SDK.
            ...(modelRegistry && { modelRuntime: getModelRuntime(modelRegistry) }),
        });
        if (signal?.aborted) {
            session.dispose();
            throw new Error("Subagent was aborted");
        }

        if (resolvedModel) {
            mirror?.setModel({
                provider: resolvedModel.provider,
                id: resolvedModel.id,
                name: resolvedModel.name,
                reasoning: resolvedModel.reasoning,
                contextWindow: resolvedModel.contextWindow,
            });
        }

        // Subscribe to events to track messages and usage
        const unsubscribe = session.subscribe((event) => {
            // Stream to the relay child session the same way a linked session
            // does; snapshots below stay as hydration for late/reconnecting viewers.
            mirror?.forward(event);

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
                        currentResult.usage.cost += Math.max(0, (usage.cost as any)?.total ?? 0);
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
    } finally {
        // Covers every exit path after the mirror exists: success, failure,
        // and the abort re-throw.
        mirror?.finish(currentResult);
    }
}
