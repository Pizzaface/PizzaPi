import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * SpawnSession extension — provides a tool that allows the agent to spawn a new
 * headless session on a runner, optionally selecting a specific model and
 * providing an initial prompt for the new session.
 *
 * The tool communicates with the PizzaPi relay server to request the runner to
 * spawn a new worker process. The new session runs independently and can be
 * monitored through the web UI.
 */
export const spawnSessionExtension: ExtensionFactory = (pi) => {
    function getRelayHttpBaseUrl(): string | null {
        const configured =
            process.env.PIZZAPI_RELAY_URL ??
            loadConfig(process.cwd()).relayUrl ??
            "ws://localhost:3001";

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

    pi.registerTool({
        name: "spawn_session",
        label: "Spawn Session",
        description:
            "Spawn a new independent agent session on the runner. The new session runs in " +
            "parallel and can be monitored through the PizzaPi web UI. Use this to delegate " +
            "work to a separate agent session, optionally specifying a model and working directory. " +
            "Returns the session ID and share URL of the spawned session.",
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
                    description:
                        "Working directory for the new session. Defaults to the current session's working directory.",
                },
                runnerId: {
                    type: "string",
                    description:
                        "Runner ID to spawn on. Usually not needed — defaults to the current runner.",
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
            };

            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const prompt = params.prompt?.trim();
            if (!prompt) {
                return ok("Error: prompt is required and cannot be empty.", { error: "Missing prompt" });
            }

            const relayBase = getRelayHttpBaseUrl();
            if (!relayBase) {
                return ok("Error: Relay is disabled. Cannot spawn sessions without a relay connection.", { error: "Relay disabled" });
            }

            const apiKey = getApiKey();
            if (!apiKey) {
                return ok("Error: No API key configured. Set PIZZAPI_API_KEY to spawn sessions.", { error: "No API key" });
            }

            // Determine runner ID — prefer explicit param, then env, then state file
            const runnerId = params.runnerId ?? getRunnerIdFromState();
            if (!runnerId) {
                return ok("Error: Could not determine runner ID. Pass runnerId explicitly or ensure the runner state file exists.", { error: "No runner ID" });
            }

            const cwd = params.cwd ?? process.cwd();

            // Build the spawn request
            const body: Record<string, unknown> = {
                runnerId,
                cwd,
                prompt,
            };

            if (params.model) {
                body.model = {
                    provider: params.model.provider,
                    id: params.model.id,
                };
            }

            try {
                const response = await fetch(`${relayBase}/api/runners/spawn`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                    },
                    body: JSON.stringify(body),
                });

                const result = await response.json() as Record<string, unknown>;

                if (!response.ok) {
                    const errorMsg = typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
                    return ok(`Error spawning session: ${errorMsg}`, { error: errorMsg, status: response.status });
                }

                const sessionId = result.sessionId as string;
                const pending = result.pending === true;
                const shareUrl = `${relayBase}/session/${sessionId}`;

                const summary = [
                    `Session spawned successfully.`,
                    `  Session ID: ${sessionId}`,
                    `  Runner: ${runnerId}`,
                    `  Working directory: ${cwd}`,
                    params.model ? `  Model: ${params.model.provider}/${params.model.id}` : null,
                    pending ? `  Status: Pending (worker is starting up)` : `  Status: Ready`,
                    `  Web UI: ${shareUrl}`,
                ].filter(Boolean).join("\n");

                return ok(summary, {
                    sessionId,
                    runnerId,
                    cwd,
                    model: params.model ?? null,
                    pending,
                    shareUrl,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error spawning session: ${message}`, { error: message });
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    pi.registerTool({
        name: "list_models",
        label: "List Models",
        description:
            "List models and providers available on this runner. Use this to discover what " +
            "values are valid for the `model` parameter of spawn_session. " +
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

            const allModels = ctx.modelRegistry.getAll();
            const availableModels = ctx.modelRegistry.getAvailable();
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
};
