import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";
import { messageBus, type CompletionResult } from "./session-message-bus.js";

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * SpawnSession extension — provides tools for delegating work to sub-agents.
 *
 * Streamlined API (3 tools):
 *   spawn_and_wait  — Spawn a sub-agent and wait for its result (or fire-and-forget with noWait)
 *   fan_out         — Spawn multiple sub-agents in parallel and wait for all results
 *   list_models     — Discover available models for sub-agent spawning
 *
 * The underlying messaging infrastructure (session-message-bus.ts) handles all
 * inter-agent communication automatically. Agents don't need to manage session
 * IDs, message passing, or delivery modes — they just delegate tasks and get results.
 */
/** Result of a single spawn operation (used by spawn_and_wait and fan_out). */
interface SpawnResult {
    sessionId: string;
    runnerId: string;
    shareUrl: string;
    error?: string;
}

export const spawnSessionExtension: ExtensionFactory = (pi) => {
    function getRelayHttpBaseUrl(): string | null {
        const configured =
            process.env.PIZZAPI_RELAY_URL ??
            loadConfig(process.cwd()).relayUrl ??
            "ws://localhost:7492";

        if (configured.toLowerCase() === "off") return null;

        const trimmed = configured.trim().replace(/\/$/, "").replace(/\/ws\/sessions$/, "");
        // Normalize to HTTP(S) base URL
        if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
        if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
        // No scheme — treat as a secure remote host (e.g. "example.com" or "example.com:5173")
        return `https://${trimmed}`;
    }

    function getApiKey(): string | undefined {
        return (
            process.env.PIZZAPI_API_KEY ??
            process.env.PIZZAPI_API_TOKEN ??
            loadConfig(process.cwd()).apiKey
        );
    }

    function getRunnerIdFromState(): string | null {
        const statePath = process.env.PIZZAPI_RUNNER_STATE_PATH ?? join(homedir(), ".pizzapi", "runner.json");
        try {
            if (!existsSync(statePath)) return null;
            const state = JSON.parse(readFileSync(statePath, "utf-8"));
            return typeof state.runnerId === "string" ? state.runnerId : null;
        } catch {
            return null;
        }
    }

    /**
     * Shared spawn helper — calls the relay spawn endpoint.
     * Returns { sessionId, runnerId, shareUrl } on success, or { error } on failure.
     */
    async function doSpawn(params: {
        prompt: string;
        model?: { provider: string; id: string };
        cwd?: string;
        runnerId?: string;
        noAutoReply?: boolean;
    }): Promise<SpawnResult & { pending?: boolean }> {
        const relayBase = getRelayHttpBaseUrl();
        if (!relayBase) {
            return { sessionId: "", runnerId: "", shareUrl: "", error: "Relay is disabled. Cannot spawn sessions without a relay connection." };
        }

        const key = getApiKey();
        if (!key) {
            return { sessionId: "", runnerId: "", shareUrl: "", error: "No API key configured. Set PIZZAPI_API_KEY to spawn sessions." };
        }

        const runnerId = params.runnerId ?? getRunnerIdFromState();
        if (!runnerId) {
            return { sessionId: "", runnerId: "", shareUrl: "", error: "Could not determine runner ID. Pass runnerId explicitly or ensure the runner state file exists." };
        }

        const cwd = params.cwd ?? process.cwd();

        const body: Record<string, unknown> = {
            runnerId,
            cwd,
            prompt: params.prompt,
        };

        if (params.model) {
            body.model = { provider: params.model.provider, id: params.model.id };
        }

        // Set this session as the parent so the child can send completion events back
        const ownSessionId = messageBus.getOwnSessionId();
        if (ownSessionId) {
            body.parentSessionId = ownSessionId;
        }

        if (params.noAutoReply) {
            body.env = { ...(body.env as Record<string, string> ?? {}), PIZZAPI_NO_AUTO_REPLY: "1" };
        }

        try {
            const response = await fetch(`${relayBase}/api/runners/spawn`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": key,
                },
                body: JSON.stringify(body),
            });

            const result = await response.json() as Record<string, unknown>;

            if (!response.ok) {
                const errorMsg = typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
                return { sessionId: "", runnerId, shareUrl: "", error: errorMsg };
            }

            const sessionId = result.sessionId as string;
            const pending = result.pending === true;
            const shareUrl = `${relayBase}/session/${sessionId}`;

            return { sessionId, runnerId, shareUrl, pending };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { sessionId: "", runnerId: "", shareUrl: "", error: message };
        }
    }

    // NOTE: The standalone `spawn_session` tool has been removed in favor of
    // `spawn_and_wait` with the `noWait` flag. The `doSpawn()` helper above is
    // still used internally by `spawn_and_wait` and `fan_out`.

    pi.registerTool({
        name: "list_models",
        label: "List Models",
        description:
            "List models and providers available on this runner. Use this to discover what " +
            "values are valid for the `model` parameter of spawn_and_wait and fan_out. " +
            "Returns each model's provider, ID, display name, and whether credentials are configured.",
        parameters: {
            type: "object",
            properties: {
                onlyAvailable: {
                    type: "boolean",
                    description:
                        "When true, only return models that have credentials configured and are ready to use. " +
                        "Defaults to false (returns all registered models).",
                },
            },
        } as any,

        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
            const params = (rawParams ?? {}) as { onlyAvailable?: boolean };

            // Load hidden models from env (set by the runner daemon from user preferences).
            // Format: JSON array of "provider/modelId" strings.
            let hiddenModelKeys: Set<string>;
            try {
                const raw = process.env.PIZZAPI_HIDDEN_MODELS;
                hiddenModelKeys = raw
                    ? new Set(JSON.parse(raw).filter((x: unknown): x is string => typeof x === "string"))
                    : new Set();
            } catch {
                hiddenModelKeys = new Set();
            }

            const isHidden = (m: { provider: string | symbol; id: string }) =>
                hiddenModelKeys.has(`${String(m.provider)}/${m.id}`);

            const allModels = ctx.modelRegistry.getAll().filter((m) => !isHidden(m));
            const availableModels = ctx.modelRegistry.getAvailable().filter((m) => !isHidden(m));
            const availableKeys = new Set(availableModels.map((m) => `${m.provider}:${m.id}`));

            const models = params.onlyAvailable ? availableModels : allModels;

            if (models.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "No models found." }],
                    details: null as any,
                };
            }

            // Group by provider
            const byProvider = new Map<string, typeof models>();
            for (const m of models) {
                const providerKey = String(m.provider);
                const list = byProvider.get(providerKey) ?? [];
                list.push(m);
                byProvider.set(providerKey, list);
            }

            const lines: string[] = [
                `${models.length} model(s) — ${availableModels.length} with credentials\n`,
            ];

            for (const [provider, providerModels] of byProvider) {
                lines.push(`Provider: ${provider}`);
                for (const m of providerModels) {
                    const available = availableKeys.has(`${m.provider}:${m.id}`);
                    const flags = [
                        available ? "✓ credentials" : "✗ no credentials",
                        m.reasoning ? "reasoning" : null,
                        `ctx:${(m.contextWindow / 1000).toFixed(0)}k`,
                    ].filter(Boolean).join(", ");
                    lines.push(`  ${m.id}  (${m.name})  [${flags}]`);
                }
                lines.push("");
            }

            const details = models.map((m) => ({
                provider: String(m.provider),
                id: m.id,
                name: m.name,
                available: availableKeys.has(`${m.provider}:${m.id}`),
                reasoning: m.reasoning,
                contextWindow: m.contextWindow,
                maxTokens: m.maxTokens,
            }));

            return {
                content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
                details: { models: details } as any,
            };
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── spawn_and_wait ────────────────────────────────────────────────────────

    pi.registerTool({
        name: "spawn_and_wait",
        label: "Spawn and Wait",
        description:
            "Spawn a sub-agent and wait for its completion result. " +
            "Returns the session ID, result text, token usage, and any error. " +
            "Set noWait=true to spawn a background session without waiting (fire-and-forget).",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description:
                        "The initial prompt/instructions to send to the new session. " +
                        "Be specific and self-contained — the new session has no context from this one.",
                },
                model: {
                    type: "object",
                    description: "Optional model to use for the new session. If omitted, uses the runner's default.",
                    properties: {
                        provider: {
                            type: "string",
                            description: "Model provider (e.g. 'anthropic', 'google', 'openai').",
                        },
                        id: {
                            type: "string",
                            description: "Model ID (e.g. 'claude-sonnet-4-20250514', 'gemini-2.5-pro').",
                        },
                    },
                    required: ["provider", "id"],
                },
                cwd: {
                    type: "string",
                    description: "Working directory for the new session. Defaults to the current session's working directory.",
                },
                runnerId: {
                    type: "string",
                    description: "Runner ID to spawn on. Usually not needed — defaults to the current runner.",
                },
                timeout: {
                    type: "number",
                    description: "Maximum time to wait for completion in seconds. Defaults to 600 (10 minutes). Ignored when noWait is true.",
                },
                noWait: {
                    type: "boolean",
                    description:
                        "If true, spawn the session and return immediately without waiting for completion. " +
                        "The session runs in the background and can be monitored via the web UI. " +
                        "Use this for long-running background tasks where you don't need the result.",
                },
            },
            required: ["prompt"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as {
                prompt: string;
                model?: { provider: string; id: string };
                cwd?: string;
                runnerId?: string;
                timeout?: number;
                noWait?: boolean;
            };

            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const prompt = params.prompt?.trim();
            if (!prompt) {
                return ok("Error: prompt is required and cannot be empty.", { error: "Missing prompt" });
            }

            const noWait = params.noWait === true;
            const timeoutSec = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : 600;

            // Spawn the session
            const spawn = await doSpawn({
                prompt,
                model: params.model,
                cwd: params.cwd,
                runnerId: params.runnerId,
                noAutoReply: noWait, // fire-and-forget sessions don't need auto-reply
            });

            if (spawn.error) {
                return ok(`Error spawning session: ${spawn.error}`, {
                    sessionId: null,
                    error: spawn.error,
                });
            }

            // Fire-and-forget mode: return immediately with session info
            if (noWait) {
                const relayBase = getRelayHttpBaseUrl()!;
                const shareUrl = `${relayBase}/session/${spawn.sessionId}`;
                const summary = [
                    `Session spawned (background, not waiting for completion).`,
                    `  Session ID: ${spawn.sessionId}`,
                    `  Runner: ${spawn.runnerId}`,
                    params.model ? `  Model: ${params.model.provider}/${params.model.id}` : null,
                    spawn.pending ? `  Status: Pending (worker is starting up)` : `  Status: Ready`,
                    `  Web UI: ${shareUrl}`,
                ].filter(Boolean).join("\n");

                return ok(summary, {
                    sessionId: spawn.sessionId,
                    runnerId: spawn.runnerId,
                    shareUrl,
                    model: params.model ?? null,
                    pending: spawn.pending ?? false,
                    noWait: true,
                });
            }

            // Wait for completion from the spawned session
            try {
                const completion = await messageBus.waitForCompletion(
                    spawn.sessionId,
                    timeoutSec * 1000,
                );

                const lines = [
                    `Sub-agent completed.`,
                    `  Session ID: ${completion.sessionId}`,
                    completion.error ? `  Error: ${completion.error}` : null,
                    `  Result: ${completion.result}`,
                ].filter(Boolean).join("\n");

                return ok(lines, {
                    sessionId: completion.sessionId,
                    result: completion.result,
                    tokenUsage: completion.tokenUsage ?? null,
                    error: completion.error ?? null,
                });
            } catch (err) {
                // Timeout or other error
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Timed out waiting for session ${spawn.sessionId} after ${timeoutSec}s.`, {
                    sessionId: spawn.sessionId,
                    result: null,
                    tokenUsage: null,
                    error: message,
                });
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── fan_out ───────────────────────────────────────────────────────────────

    pi.registerTool({
        name: "fan_out",
        label: "Fan Out",
        description:
            "Spawn multiple sub-agents and wait for all to complete. " +
            "Returns an array of results (ordered by completion). " +
            "Supports partial failure — completed results are returned alongside errors for failed sessions.",
        parameters: {
            type: "object",
            properties: {
                tasks: {
                    type: "array",
                    description: "Array of tasks to spawn. Each task creates a separate sub-agent session.",
                    items: {
                        type: "object",
                        properties: {
                            prompt: {
                                type: "string",
                                description: "The prompt for this sub-agent.",
                            },
                            model: {
                                type: "object",
                                description: "Optional model override for this task.",
                                properties: {
                                    provider: { type: "string" },
                                    id: { type: "string" },
                                },
                                required: ["provider", "id"],
                            },
                            cwd: {
                                type: "string",
                                description: "Optional working directory override for this task.",
                            },
                        },
                        required: ["prompt"],
                    },
                },
                maxConcurrent: {
                    type: "number",
                    description: "Maximum number of sessions to run concurrently. Defaults to 5.",
                },
                timeout: {
                    type: "number",
                    description: "Per-task timeout in seconds. Defaults to 600 (10 minutes).",
                },
            },
            required: ["tasks"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as {
                tasks: Array<{ prompt: string; model?: { provider: string; id: string }; cwd?: string }>;
                maxConcurrent?: number;
                timeout?: number;
            };

            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
                return ok("Error: tasks array is required and must not be empty.", { error: "Missing tasks" });
            }

            const maxConcurrent = typeof params.maxConcurrent === "number" && params.maxConcurrent > 0
                ? params.maxConcurrent
                : 5;
            const timeoutSec = typeof params.timeout === "number" && params.timeout > 0
                ? params.timeout
                : 600;

            const results: Array<{
                sessionId: string;
                result: string | null;
                tokenUsage: Record<string, unknown> | null;
                error: string | null;
            }> = [];

            // Queue of tasks not yet spawned
            const taskQueue = [...params.tasks];
            const activePromises = new Map<string, Promise<void>>();

            /**
             * Spawn a single task and wait for its completion.
             * On completion (success or error), the result is pushed to `results`.
             */
            async function spawnAndCollect(task: { prompt: string; model?: { provider: string; id: string }; cwd?: string }) {
                const spawn = await doSpawn({
                    prompt: task.prompt,
                    model: task.model,
                    cwd: task.cwd,
                    noAutoReply: false,
                });

                if (spawn.error) {
                    results.push({
                        sessionId: spawn.sessionId || "(spawn failed)",
                        result: null,
                        tokenUsage: null,
                        error: `Spawn failed: ${spawn.error}`,
                    });
                    return;
                }

                try {
                    const completion = await messageBus.waitForCompletion(
                        spawn.sessionId,
                        timeoutSec * 1000,
                    );
                    results.push({
                        sessionId: completion.sessionId,
                        result: completion.result,
                        tokenUsage: completion.tokenUsage ?? null,
                        error: completion.error ?? null,
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    results.push({
                        sessionId: spawn.sessionId,
                        result: null,
                        tokenUsage: null,
                        error: message,
                    });
                }
            }

            // Spawn initial batch up to maxConcurrent
            while (taskQueue.length > 0 && activePromises.size < maxConcurrent) {
                const task = taskQueue.shift()!;
                const promise = spawnAndCollect(task);
                // Use a unique key since we don't have sessionId yet
                const key = `task-${results.length + activePromises.size}`;
                const tracked = promise.then(() => { activePromises.delete(key); });
                activePromises.set(key, tracked);
            }

            // As tasks complete, spawn remaining from queue
            while (activePromises.size > 0 || taskQueue.length > 0) {
                if (activePromises.size > 0) {
                    // Wait for any one to complete
                    await Promise.race(activePromises.values());
                }

                // Spawn more if we have capacity
                while (taskQueue.length > 0 && activePromises.size < maxConcurrent) {
                    const task = taskQueue.shift()!;
                    const promise = spawnAndCollect(task);
                    const key = `task-${results.length + activePromises.size}-${Date.now()}`;
                    const tracked = promise.then(() => { activePromises.delete(key); });
                    activePromises.set(key, tracked);
                }
            }

            // Build summary
            const succeeded = results.filter((r) => !r.error).length;
            const failed = results.filter((r) => r.error).length;

            const lines = [
                `Fan-out complete: ${succeeded} succeeded, ${failed} failed out of ${results.length} total.`,
                "",
                ...results.map((r, i) => {
                    if (r.error) {
                        return `  [${i + 1}] ${r.sessionId} — ERROR: ${r.error}`;
                    }
                    const preview = (r.result ?? "").slice(0, 200);
                    return `  [${i + 1}] ${r.sessionId} — ${preview}${(r.result?.length ?? 0) > 200 ? "..." : ""}`;
                }),
            ];

            return ok(lines.join("\n"), {
                results,
                succeeded,
                failed,
                total: results.length,
            });
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── System prompt injection ───────────────────────────────────────────────
    // Append concise sub-agent delegation guidelines to the system prompt so the
    // agent always knows how to use spawn_and_wait / fan_out without consulting
    // external docs.

    const SUB_AGENT_PROMPT = `

## Sub-Agent Delegation

You have 3 tools for delegating work to sub-agents. The infrastructure handles all communication automatically.

- **\`spawn_and_wait\`** — Spawn a sub-agent and get its result. The primary tool for delegation.
  - Set \`noWait: true\` to spawn a background task without waiting.
- **\`fan_out\`** — Spawn multiple sub-agents in parallel and get all results.
- **\`list_models\`** — Discover available models for sub-agents.

Rules:
- Sub-agent prompts must be **self-contained** — they have no context from this session.
- Prefer \`spawn_and_wait\` for most tasks. Use \`fan_out\` when tasks are independent.
- Use \`noWait: true\` only for long-running background tasks where you don't need the result.`;

    pi.on("before_agent_start", (event) => {
        return {
            systemPrompt: event.systemPrompt + SUB_AGENT_PROMPT,
        };
    });
};
