/**
 * PizzaPi Remote extension — orchestrator.
 *
 * Automatically connects to the PizzaPi relay on session start and streams all
 * agent events in real-time so any browser client can pick up the session.
 *
 * This file is the orchestrator: it creates the RelayContext, manages the
 * Socket.IO connection lifecycle, and wires together the extracted modules.
 *
 * Config:
 *   PIZZAPI_RELAY_URL  WebSocket URL of the relay (default: ws://localhost:7492)
 *                      Set to "off" to disable auto-connect.
 *
 * Commands:
 *   /remote            Show the current share URL (or "not connected")
 *   /remote stop       Disconnect from relay
 *   /remote reconnect  Force reconnect
 *
 * Note: The `new_session` and `resume_session` exec handlers rely on a Bun
 * patch applied to `@mariozechner/pi-coding-agent` that exposes
 * `newSession()`/`switchSession()` on the extension runtime.
 * See `patches/README.md` for details.
 *
 * Sub-modules (all in the same `remote/` folder):
 *   chunked-delivery.ts  — session_active chunking to avoid transport limits
 *   registration-gate.ts — gate for waiting until relay is registered
 *   connection.ts        — Socket.IO connect/disconnect + all server events
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, type ExtensionContext, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../../config.js";
import { setTodoUpdateCallback, type TodoItem } from "../update-todo.js";
import { getCurrentTodoList } from "../update-todo.js";
import { setPlanModeChangeCallback } from "../plan-mode-toggle.js";
import type { RemoteExecResponse } from "../remote-commands.js";
import type { ConversationTrigger } from "../triggers/types.js";
import type { Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import type {
    RelayContext,
    RelayModelInfo,
    TriggerResponse,
} from "../remote-types.js";
import { installFooter } from "../remote-footer.js";
import { buildHeartbeat, stopHeartbeat } from "../remote-heartbeat.js";
import { registerAskUserTool } from "../remote-ask-user.js";
import { registerPlanModeTool } from "../remote-plan-mode.js";

// ── Sub-modules ───────────────────────────────────────────────────────────────
import { emitSessionActive, estimateMessagesSize, needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries } from "./chunked-delivery.js";
import { waitForRelayRegistrationGated } from "./registration-gate.js";
import { connect, disconnect, isDisabled, toWebSocketBaseUrl, type ConnectionHandlers } from "./connection.js";

// Re-export chunked-delivery utilities so existing importers (e.g. tests) that
// import from the top-level `remote.js` barrel continue to work unchanged.
export { estimateMessagesSize, needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries };

const RELAY_DEFAULT = "ws://localhost:7492";
const RELAY_STATUS_KEY = "relay";

// ── Module-level state for external consumers ─────────────────────────────────
let _ctx: RelayContext | null = null;

/** Forward a CLI-side error to all active relay viewers. */
export function forwardCliError(message: string, source?: string): void {
    _ctx?.forwardEvent({ type: "cli_error", message, source: source ?? null, ts: Date.now() });
}

/** Get the active relay socket and token, or null if not connected/registered. */
export function getRelaySocket(): { socket: Socket<RelayServerToClientEvents, RelayClientToServerEvents>; token: string } | null {
    return _ctx?.sioSocket?.connected && _ctx.relay
        ? { socket: _ctx.sioSocket, token: _ctx.relay.token }
        : null;
}

/**
 * Get the relay session ID. Returns the session ID even while disconnected
 * (e.g. during reconnect windows) so child-session linking via spawn_session
 * doesn't break. Falls back to PIZZAPI_SESSION_ID env var.
 */
export function getRelaySessionId(): string | null {
    return _ctx?.relaySessionId ?? process.env.PIZZAPI_SESSION_ID ?? null;
}

/**
 * Wait for the relay to complete registration, with a timeout fallback.
 * Resolves immediately if the relay is already registered or was skipped.
 * Falls back after `timeoutMs` so the caller isn't blocked forever if the
 * relay connection fails.
 */
export function waitForRelayRegistration(timeoutMs: number = 10_000): Promise<void> {
    // Already registered or relay was never initialized
    if (_ctx?.relay) return Promise.resolve();
    return waitForRelayRegistrationGated(timeoutMs);
}

// ── Extension factory ─────────────────────────────────────────────────────────

export const remoteExtension: ExtensionFactory = (pi) => {
    // ── Orchestrator-local state (NOT in RelayContext) ─────────────────────
    let sessionCompleteFired = false;
    let followUpGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionNameSyncTimer: ReturnType<typeof setInterval> | null = null;
    let lastBroadcastSessionName: string | null = null;

    // ── RelayContext creation ─────────────────────────────────────────────
    const rctx: RelayContext = {
        pi,
        relay: null,
        sioSocket: null,
        latestCtx: null,

        isAgentActive: false,
        isCompacting: false,
        shuttingDown: false,
        wasAborted: false,
        sessionStartedAt: null,
        lastRetryableError: null,

        parentSessionId: process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null,
        isChildSession: (process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null) !== null,
        relaySessionId: (process.env.PIZZAPI_SESSION_ID && process.env.PIZZAPI_SESSION_ID.trim().length > 0)
            ? process.env.PIZZAPI_SESSION_ID.trim()
            : randomUUID(),

        pendingAskUserQuestion: null,
        pendingPlanMode: null,
        pendingPluginTrust: null,

        lastMcpStartupReport: null,
        relayStatusText: "",

        forwardEvent(event: unknown) {
            if (!rctx.relay || !rctx.sioSocket?.connected) return;
            const seq = ++rctx.relay.seq;
            rctx.sioSocket.emit("event", { sessionId: rctx.relay.sessionId, token: rctx.relay.token, event, seq });
        },

        sendToWeb(payload: RemoteExecResponse) {
            if (!rctx.relay || !rctx.sioSocket?.connected) return;
            const { type: _, ...data } = payload;
            rctx.sioSocket.emit("exec_result", data);
        },

        relayUrl(): string {
            const configured =
                process.env.PIZZAPI_RELAY_URL ??
                loadConfig(process.cwd()).relayUrl ??
                RELAY_DEFAULT;
            return configured.replace(/\/$/, "");
        },

        relayHttpBaseUrl(): string {
            const wsBase = toWebSocketBaseUrl(rctx.relayUrl()).replace(/\/ws\/sessions$/, "");
            if (wsBase.startsWith("ws://")) return `http://${wsBase.slice("ws://".length)}`;
            if (wsBase.startsWith("wss://")) return `https://${wsBase.slice("wss://".length)}`;
            return wsBase;
        },

        apiKey(): string | undefined {
            return (
                process.env.PIZZAPI_API_KEY ??
                process.env.PIZZAPI_API_TOKEN ??
                loadConfig(process.cwd()).apiKey
            );
        },

        setRelayStatus(text?: string) {
            rctx.relayStatusText = text ?? "";
            if (!rctx.latestCtx) return;
            rctx.latestCtx.ui.setStatus(RELAY_STATUS_KEY, text);
        },

        disconnectedStatusText(): string | undefined {
            if (isDisabled()) return undefined;
            if (!rctx.apiKey()) return "Relay not configured — run pizza setup";
            return "Disconnected from Relay";
        },

        isConnected(): boolean {
            return !!rctx.relay && !!rctx.sioSocket?.connected;
        },

        buildSessionState() {
            if (!rctx.latestCtx) return undefined;
            const { messages, model } = buildSessionContext(
                rctx.latestCtx.sessionManager.getEntries(),
                rctx.latestCtx.sessionManager.getLeafId(),
            );
            return {
                messages,
                model,
                thinkingLevel: rctx.getCurrentThinkingLevel(),
                sessionName: rctx.getCurrentSessionName(),
                cwd: rctx.latestCtx.cwd,
                availableModels: rctx.getConfiguredModels(),
                todoList: getCurrentTodoList(),
            };
        },

        emitSessionActive() {
            emitSessionActive(rctx);
        },

        buildHeartbeat() {
            return buildHeartbeat(rctx);
        },

        buildCapabilitiesState() {
            if (!rctx.latestCtx) {
                return { type: "capabilities", models: [], commands: [] };
            }
            const commands = (pi.getCommands?.() ?? []).map((c: any) => ({
                name: c.name,
                description: c.description,
                source: c.source,
            }));
            return {
                type: "capabilities",
                models: rctx.getConfiguredModels(),
                commands,
            };
        },

        getConfiguredModels(): RelayModelInfo[] {
            if (!rctx.latestCtx) return [];
            return rctx.latestCtx.modelRegistry
                .getAvailable()
                .map((model) => ({
                    provider: model.provider,
                    id: model.id,
                    name: model.name,
                    reasoning: model.reasoning,
                    contextWindow: model.contextWindow,
                }))
                .sort((a, b) => {
                    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                    return a.id.localeCompare(b.id);
                });
        },

        getCurrentSessionName(): string | null {
            if (!rctx.latestCtx) return null;
            const raw = rctx.latestCtx.sessionManager.getSessionName();
            if (typeof raw !== "string") return null;
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        },

        getCurrentThinkingLevel(): string | null {
            const api = pi as any;
            if (typeof api.getThinkingLevel === "function") {
                const level = api.getThinkingLevel();
                if (typeof level === "string") {
                    const trimmed = level.trim();
                    if (trimmed) return trimmed;
                }
            }
            if (!rctx.latestCtx) return null;
            const { thinkingLevel } = buildSessionContext(rctx.latestCtx.sessionManager.getEntries(), rctx.latestCtx.sessionManager.getLeafId());
            return thinkingLevel ?? null;
        },

        markSessionNameBroadcasted() {
            lastBroadcastSessionName = rctx.getCurrentSessionName();
        },

        emitTrigger(trigger: ConversationTrigger) {
            if (!rctx.relay || !rctx.sioSocket?.connected) return;
            rctx.sioSocket.emit("session_trigger" as any, { token: rctx.relay.token, trigger });
        },

        waitForTriggerResponse(triggerId: string, timeoutMs: number, signal?: AbortSignal): Promise<TriggerResponse> {
            return new Promise<TriggerResponse>((resolve) => {
                const timeout = setTimeout(() => {
                    cleanup();
                    resolve({ response: "Trigger timed out — no response from parent within 5 minutes.", cancelled: true });
                }, timeoutMs);

                const handler = (data: { triggerId: string; response: string; action?: string }) => {
                    if (data.triggerId === triggerId) {
                        cleanup();
                        resolve({ response: data.response, action: data.action, cancelled: false });
                    }
                };

                const errorHandler = (data: { targetSessionId: string; error: string }) => {
                    if (data.targetSessionId === rctx.parentSessionId) {
                        cleanup();
                        resolve({ response: `Trigger delivery failed: ${data.error}`, cancelled: true });
                    }
                };

                const cleanup = () => {
                    clearTimeout(timeout);
                    rctx.sioSocket?.off("trigger_response" as any, handler);
                    rctx.sioSocket?.off("session_message_error" as any, errorHandler);
                };

                rctx.sioSocket!.on("trigger_response" as any, handler);
                rctx.sioSocket!.on("session_message_error" as any, errorHandler);
                signal?.addEventListener("abort", () => { cleanup(); resolve({ response: "Aborted", cancelled: true }); });
            });
        },
    };

    // Set module-level ref for external consumers
    _ctx = rctx;

    // ── Register tools ────────────────────────────────────────────────────
    registerAskUserTool(rctx);
    registerPlanModeTool(rctx);

    // ── Wire up callbacks ─────────────────────────────────────────────────

    setTodoUpdateCallback((list: TodoItem[]) => {
        rctx.forwardEvent({ type: "todo_update", todos: list, ts: Date.now() });
    });

    setPlanModeChangeCallback((_enabled: boolean) => {
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    // ── Session name sync ─────────────────────────────────────────────────

    function stopSessionNameSync() {
        if (sessionNameSyncTimer !== null) {
            clearInterval(sessionNameSyncTimer);
            sessionNameSyncTimer = null;
        }
    }

    function startSessionNameSync() {
        stopSessionNameSync();
        rctx.markSessionNameBroadcasted();

        sessionNameSyncTimer = setInterval(() => {
            const currentSessionName = rctx.getCurrentSessionName();
            if (currentSessionName === lastBroadcastSessionName) return;

            lastBroadcastSessionName = currentSessionName;
            emitSessionActive(rctx);
            rctx.forwardEvent(rctx.buildHeartbeat());
        }, 1000);
    }

    // ── Model set from web ────────────────────────────────────────────────

    async function setModelFromWeb(provider: string, modelId: string) {
        if (!rctx.latestCtx) return;

        const model = rctx.latestCtx.modelRegistry.find(provider, modelId);
        if (!model) {
            rctx.forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: "Model is not configured for this session.",
            });
            return;
        }

        try {
            const ok = await pi.setModel(model);
            rctx.forwardEvent({
                type: "model_set_result",
                ok,
                provider,
                modelId,
                message: ok ? undefined : "Model selected, but no valid credentials were found.",
            });
            if (ok) {
                emitSessionActive(rctx);
            }
        } catch (error) {
            rctx.forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // ── Follow-up grace period ────────────────────────────────────────────

    const FOLLOWUP_GRACE_MS = 10 * 60 * 1000;

    function clearFollowUpGrace() {
        if (followUpGraceTimer !== null) {
            clearTimeout(followUpGraceTimer);
            followUpGraceTimer = null;
        }
    }

    function startFollowUpGrace(ctx: { shutdown: () => void }) {
        clearFollowUpGrace();
        console.log(`pizzapi: waiting ${FOLLOWUP_GRACE_MS / 1000}s for parent follow-up before shutting down`);
        followUpGraceTimer = setTimeout(() => {
            followUpGraceTimer = null;
            console.log("pizzapi: follow-up grace period expired — shutting down");
            ctx.shutdown();
        }, FOLLOWUP_GRACE_MS);
        if (followUpGraceTimer && typeof followUpGraceTimer === "object" && "unref" in followUpGraceTimer) {
            (followUpGraceTimer as NodeJS.Timeout).unref();
        }
    }

    function fireSessionComplete(summary?: string, fullOutputPath?: string, exitReason?: "completed" | "killed" | "error") {
        if (sessionCompleteFired) return;
        if (!rctx.isChildSession || !rctx.parentSessionId || !rctx.relay || !rctx.sioSocket?.connected) return;
        sessionCompleteFired = true;
        rctx.sioSocket.emit("session_trigger" as any, {
            token: rctx.relay.token,
            trigger: {
                type: "session_complete",
                sourceSessionId: rctx.relay.sessionId,
                sourceSessionName: undefined,
                targetSessionId: rctx.parentSessionId,
                payload: {
                    summary: summary ?? "Session completed",
                    exitCode: exitReason === "killed" ? 130 : exitReason === "error" ? 1 : 0,
                    exitReason: exitReason ?? "completed",
                    ...(fullOutputPath ? { fullOutputPath } : {}),
                },
                deliverAs: "followUp" as const,
                expectsResponse: true,
                triggerId: crypto.randomUUID(),
                ts: new Date().toISOString(),
            },
        });
    }

    // ── Connection wrappers ───────────────────────────────────────────────
    // Wrap connect/disconnect with the factory-scoped handlers they need.

    const connectionHandlers: ConnectionHandlers = {
        clearFollowUpGrace,
        setModelFromWeb,
        sendUserMessage: (msg: unknown, opts?: { deliverAs?: "followUp" | "steer" }) =>
            pi.sendUserMessage(msg as any, opts),
    };

    function doConnect() {
        connect(rctx, connectionHandlers);
    }

    function doDisconnect() {
        disconnect(rctx);
    }

    // ── Session lifecycle events ──────────────────────────────────────────

    pi.on("session_start", (_event, ctx) => {
        rctx.latestCtx = ctx;
        rctx.sessionStartedAt = Date.now();
        rctx.isAgentActive = false;
        installFooter(rctx, ctx);
        startSessionNameSync();
        if (isDisabled()) {
            rctx.setRelayStatus(rctx.disconnectedStatusText());
            return;
        }
        doConnect();
        if (!rctx.apiKey()) {
            ctx.ui.notify(
                "⚠ Relay not configured — sessions won't appear in the web UI.\n" +
                "Run `pizza setup` or set PIZZAPI_API_KEY to connect.",
            );
        }
    });

    pi.on("session_switch", (_event, ctx) => {
        rctx.latestCtx = ctx;
        rctx.sessionStartedAt = Date.now();
        rctx.isAgentActive = false;
        installFooter(rctx, ctx);
        startSessionNameSync();
        rctx.setRelayStatus(
            rctx.pendingAskUserQuestion
                ? "Waiting for AskUserQuestion answer"
                : rctx.relay
                  ? "Connected to Relay"
                  : rctx.disconnectedStatusText(),
        );
        emitSessionActive(rctx);
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    pi.on("turn_start", (event) => {
        sessionCompleteFired = false;
        rctx.wasAborted = false;
        clearFollowUpGrace();
        rctx.forwardEvent(event);
    });

    pi.on("session_shutdown", () => {
        rctx.shuttingDown = true;
        clearFollowUpGrace();
        stopHeartbeat();
        stopSessionNameSync();
        _ctx = null;
        fireSessionComplete(undefined, undefined, rctx.wasAborted ? "killed" : "completed");
        doDisconnect();
    });

    // ── Agent lifecycle events ────────────────────────────────────────────

    pi.on("agent_start", (event) => {
        rctx.isAgentActive = true;
        rctx.lastRetryableError = null;
        rctx.forwardEvent(event);
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    pi.on("agent_end", (event, ctx) => {
        rctx.isAgentActive = false;
        rctx.lastRetryableError = null;
        rctx.forwardEvent(event);
        rctx.forwardEvent(rctx.buildHeartbeat());

        if (!ctx.hasPendingMessages()) {
            let summary = "Session completed";
            let fullOutputPath: string | undefined;
            const messages = (event as any).messages;
            if (Array.isArray(messages)) {
                for (let i = messages.length - 1; i >= 0; i--) {
                    const msg = messages[i];
                    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
                        const textParts = msg.content
                            .filter((c: any) => c.type === "text" && c.text)
                            .map((c: any) => c.text);
                        if (textParts.length > 0) {
                            const full = textParts.join("\n");
                            const INLINE_MAX = 4_000;
                            if (full.length > INLINE_MAX) {
                                try {
                                    const sessionSlug = rctx.relay?.sessionId?.slice(0, 8) ?? "unknown";
                                    const uniqueSuffix = Date.now().toString(36);
                                    const tmpPath = join(tmpdir(), `pizzapi-session-${sessionSlug}-${uniqueSuffix}-output.md`);
                                    writeFileSync(tmpPath, full, "utf-8");
                                    fullOutputPath = tmpPath;
                                } catch { /* best-effort */ }
                                summary = full.slice(0, INLINE_MAX);
                            } else {
                                summary = full;
                            }
                            break;
                        }
                    }
                }
            }
            fireSessionComplete(summary, fullOutputPath, rctx.wasAborted ? "killed" : "completed");
            if (rctx.isChildSession) {
                startFollowUpGrace(ctx);
            }
        }
    });

    pi.on("turn_end", (event) => rctx.forwardEvent(event));
    pi.on("message_start", (event) => rctx.forwardEvent(event));
    pi.on("message_update", (event) => rctx.forwardEvent(event));
    pi.on("message_end", (event) => {
        rctx.forwardEvent(event);
        const msg = (event as any).message;
        if (msg && msg.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
            const errorText = String(msg.errorMessage);
            rctx.lastRetryableError = { errorMessage: errorText, detectedAt: Date.now() };
            rctx.forwardEvent({ type: "cli_error", message: errorText, source: "provider", ts: Date.now() });
            rctx.forwardEvent(rctx.buildHeartbeat());
        }
    });
    pi.on("tool_execution_start", (event) => rctx.forwardEvent(event));
    pi.on("tool_execution_update", (event) => rctx.forwardEvent(event));
    pi.on("tool_execution_end", (event) => rctx.forwardEvent(event));
    pi.on("model_select", (event) => {
        rctx.forwardEvent(event);
        emitSessionActive(rctx);
    });

    // ── /remote command ───────────────────────────────────────────────────

    pi.registerCommand("remote", {
        description: "Show relay share URL, or: /remote stop | /remote reconnect",
        getArgumentCompletions: (prefix) => {
            const options = ["stop", "reconnect"];
            const filtered = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
            return filtered.length ? filtered.map((o) => ({ value: o, label: o })) : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();
            if (arg === "stop") {
                doDisconnect();
                ctx.ui.notify("Disconnected from relay.");
                return;
            }
            if (arg === "reconnect") {
                doDisconnect();
                rctx.shuttingDown = false;
                doConnect();
                ctx.ui.notify("Reconnecting to relay…");
                return;
            }
            if (rctx.relay) {
                ctx.ui.notify(`Connected to Relay\nShare URL: ${rctx.relay.shareUrl}`);
            } else {
                const url = isDisabled() ? "(disabled — set PIZZAPI_RELAY_URL to enable)" : rctx.relayUrl();
                ctx.ui.notify(`Not connected to relay.\nRelay: ${url}\nUse /remote reconnect to retry.`);
            }
        },
    });

    // ── Plugin trust prompt bridge ────────────────────────────────────────

    pi.events.on("plugin:trust_prompt", (data: unknown) => {
        const event = data as Record<string, unknown> | null;
        if (!event || typeof event !== "object") return;
        if (typeof event.promptId !== "string") return;
        if (!Array.isArray(event.pluginNames)) return;
        if (!Array.isArray(event.pluginSummaries)) return;
        if (typeof event.respond !== "function") return;

        if (rctx.pendingPluginTrust) {
            rctx.pendingPluginTrust.respond(false);
        }

        rctx.pendingPluginTrust = {
            promptId: event.promptId as string,
            pluginNames: event.pluginNames as string[],
            pluginSummaries: event.pluginSummaries as string[],
            respond: event.respond as (trusted: boolean) => void,
        };

        rctx.forwardEvent({
            type: "plugin_trust_prompt",
            promptId: event.promptId,
            pluginNames: event.pluginNames,
            pluginSummaries: event.pluginSummaries,
            ts: Date.now(),
        });
    });

    pi.events.on("plugin:trust_timeout", (data: unknown) => {
        const event = data as Record<string, unknown> | null;
        if (!event || typeof event.promptId !== "string") return;
        if (rctx.pendingPluginTrust?.promptId === event.promptId) {
            rctx.pendingPluginTrust = null;
            rctx.forwardEvent({
                type: "plugin_trust_expired",
                promptId: event.promptId,
                ts: Date.now(),
            });
        }
    });

    pi.events.on("plugin:loaded", () => {
        rctx.forwardEvent(rctx.buildCapabilitiesState());
    });

    // ── MCP events ────────────────────────────────────────────────────────

    pi.events.on("mcp:auth_required", (data: unknown) => rctx.forwardEvent(data));
    pi.events.on("mcp:auth_complete", (data: unknown) => rctx.forwardEvent(data));

    pi.events.on("mcp:startup_report", (report: unknown) => {
        if (report && typeof report === "object") {
            const r = report as Record<string, unknown>;
            rctx.lastMcpStartupReport = {
                toolCount: typeof r.toolCount === "number" ? r.toolCount : 0,
                serverCount: typeof r.serverCount === "number" ? r.serverCount : 0,
                totalDurationMs: typeof r.totalDurationMs === "number" ? r.totalDurationMs : 0,
                slow: r.slow === true,
                showSlowWarning: r.showSlowWarning !== false,
                errors: Array.isArray(r.errors) ? r.errors as any : [],
                serverTimings: Array.isArray(r.serverTimings) ? r.serverTimings as any : [],
                ts: typeof r.ts === "number" ? r.ts : Date.now(),
            };
        }
        rctx.forwardEvent(report);
    });
};
