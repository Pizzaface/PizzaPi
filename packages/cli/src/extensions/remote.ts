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
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, type ExtensionContext, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";
import { getMcpBridge } from "./mcp-bridge.js";
import { setTodoUpdateCallback, type TodoItem } from "./update-todo.js";
import { getCurrentTodoList } from "./update-todo.js";
import { isPlanModeEnabled, setPlanModeChangeCallback, setPlanModeFromRemote } from "./plan-mode-toggle.js";
import type { RemoteExecResponse } from "./remote-commands.js";

import { renderTrigger } from "./triggers/registry.js";
import { trackReceivedTrigger, receivedTriggers } from "./triggers/extension.js";
import type { ConversationTrigger } from "./triggers/types.js";
import { messageBus } from "./session-message-bus.js";
import { io, type Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";

// ── Extracted modules ────────────────────────────────────────────────────────
import type {
    RelayState,
    RelayContext,
    RelayModelInfo,
    McpStartupReportSummary,
    PendingPluginTrust,
    TriggerResponse,
} from "./remote-types.js";
import { getAuthSource } from "./remote-auth-source.js";
import { refreshAllUsage, buildProviderUsage } from "./remote-provider-usage.js";
import { normalizeRemoteInputAttachments, buildUserMessageFromRemoteInput } from "./remote-input.js";
import { installFooter } from "./remote-footer.js";
import { buildHeartbeat, startHeartbeat, stopHeartbeat } from "./remote-heartbeat.js";
import { handleExecFromWeb } from "./remote-exec-handler.js";
import { registerAskUserTool, consumePendingAskUserQuestionFromWeb, cancelPendingAskUserQuestion } from "./remote-ask-user.js";
import { registerPlanModeTool, consumePendingPlanModeFromWeb, cancelPendingPlanMode } from "./remote-plan-mode.js";

const RELAY_DEFAULT = "ws://localhost:7492";
const RELAY_STATUS_KEY = "relay";

// ── Module-level state for external consumers ────────────────────────────────
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

// ── Extension factory ────────────────────────────────────────────────────────

export const remoteExtension: ExtensionFactory = (pi) => {
    // ── Orchestrator-local state (NOT in RelayContext) ─────────────────────
    let connectFailureNotified = false;
    let sessionCompleteFired = false;
    let followUpGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionNameSyncTimer: ReturnType<typeof setInterval> | null = null;
    let lastBroadcastSessionName: string | null = null;
    const oauthPendingCallbacks = new Map<string, (code: string) => void>();

    // ── RelayContext creation ─────────────────────────────────────────────
    const rctx: RelayContext = {
        pi,
        relay: null,
        sioSocket: null,
        latestCtx: null,

        isAgentActive: false,
        isCompacting: false,
        shuttingDown: false,
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

    // ── Core relay helpers ────────────────────────────────────────────────

    function toWebSocketBaseUrl(value: string): string {
        const trimmed = value.trim().replace(/\/$/, "");
        if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
        if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
        if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
        return `wss://${trimmed}`;
    }

    function isDisabled(): boolean {
        const configured = process.env.PIZZAPI_RELAY_URL ?? loadConfig(process.cwd()).relayUrl ?? "";
        return configured.toLowerCase() === "off";
    }

    function socketIoUrl(): string {
        const explicit = process.env.PIZZAPI_SOCKETIO_URL;
        if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, "");
        const base = rctx.relayUrl();
        return base.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
    }

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
            rctx.forwardEvent({ type: "session_active", state: rctx.buildSessionState() });
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
                rctx.forwardEvent({ type: "session_active", state: rctx.buildSessionState() });
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

    function fireSessionComplete(summary?: string, fullOutputPath?: string) {
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
                    exitCode: 0,
                    ...(fullOutputPath ? { fullOutputPath } : {}),
                },
                deliverAs: "followUp" as const,
                expectsResponse: true,
                triggerId: crypto.randomUUID(),
                ts: new Date().toISOString(),
            },
        });
    }

    // ── MCP relay context ─────────────────────────────────────────────────

    function updateMcpRelayContext() {
        const bridge = getMcpBridge();
        if (!bridge?.setRelayContext) return;

        if (rctx.relay && rctx.sioSocket?.connected) {
            bridge.setRelayContext({
                serverBaseUrl: rctx.relayHttpBaseUrl(),
                sessionId: rctx.relay.sessionId,
                emitEvent: (_eventName: string, data: unknown) => {
                    rctx.forwardEvent(data);
                },
                waitForCallback: (nonce: string, timeoutMs: number = 120_000) => {
                    return new Promise<string>((resolve, reject) => {
                        const timer = setTimeout(() => {
                            oauthPendingCallbacks.delete(nonce);
                            reject(new Error("OAuth callback timed out"));
                        }, timeoutMs);

                        oauthPendingCallbacks.set(nonce, (code: string) => {
                            clearTimeout(timer);
                            resolve(code);
                        });
                    });
                },
            });
        } else {
            bridge.setRelayContext(null);
        }
    }

    // ── Socket.IO connection ─────────────────────────────────────────────

    function connect() {
        if (isDisabled() || rctx.shuttingDown) {
            rctx.setRelayStatus(rctx.disconnectedStatusText());
            return;
        }

        const key = rctx.apiKey();
        if (!key) {
            rctx.setRelayStatus(rctx.disconnectedStatusText());
            return;
        }

        if (rctx.sioSocket) {
            rctx.sioSocket.removeAllListeners();
            rctx.sioSocket.disconnect();
            rctx.sioSocket = null;
        }

        const sioUrl = socketIoUrl();

        const sock: Socket<RelayServerToClientEvents, RelayClientToServerEvents> = io(
            sioUrl + "/relay",
            {
                auth: { apiKey: key },
                transports: ["websocket"],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 30_000,
            },
        );
        rctx.sioSocket = sock;

        // ── Connection lifecycle ──────────────────────────────────────────

        sock.on("connect", () => {
            sock.emit("register", {
                sessionId: rctx.relaySessionId,
                cwd: process.cwd(),
                ephemeral: true,
                collabMode: true,
                sessionName: rctx.getCurrentSessionName() ?? undefined,
                ...(rctx.parentSessionId ? { parentSessionId: rctx.parentSessionId } : {}),
            });
        });

        sock.on("registered", (data) => {
            rctx.relaySessionId = data.sessionId;
            rctx.relay = {
                sessionId: data.sessionId,
                token: data.token,
                shareUrl: data.shareUrl,
                seq: 0,
                ackedSeq: 0,
            };
            connectFailureNotified = false;
            rctx.setRelayStatus("Connected to Relay");

            messageBus.setOwnSessionId(rctx.relaySessionId);
            messageBus.setSendFn((targetSessionId: string, message: string) => {
                if (!rctx.relay || !rctx.sioSocket?.connected) return false;
                rctx.sioSocket.emit("session_message", {
                    token: rctx.relay.token,
                    targetSessionId,
                    message,
                });
                return true;
            });

            if (data.parentSessionId) {
                rctx.parentSessionId = data.parentSessionId;
                rctx.isChildSession = true;
                console.log(`pizzapi: linked as child of parent session ${data.parentSessionId}`);
            } else if (rctx.parentSessionId && !data.parentSessionId) {
                console.log(`pizzapi: server rejected parent link (${rctx.parentSessionId}), falling back to local interaction`);
                rctx.parentSessionId = null;
                rctx.isChildSession = false;
            }

            rctx.forwardEvent({ type: "session_active", state: rctx.buildSessionState() });
            void refreshAllUsage();
            startHeartbeat(rctx);
            updateMcpRelayContext();
        });

        // ── Incoming events from server ───────────────────────────────────

        sock.on("event_ack", (data) => {
            if (rctx.relay && typeof data.seq === "number") {
                rctx.relay.ackedSeq = Math.max(rctx.relay.ackedSeq, data.seq);
            }
        });

        sock.on("connected", () => {
            rctx.forwardEvent(rctx.buildCapabilitiesState());
            rctx.forwardEvent({ type: "session_active", state: rctx.buildSessionState() });
        });

        sock.on("input", (data) => {
            const inputText = data.text;
            if (consumePendingAskUserQuestionFromWeb(rctx, inputText)) return;
            if (consumePendingPlanModeFromWeb(rctx, inputText)) return;

            const attachments = normalizeRemoteInputAttachments(data.attachments);
            const deliverAs = data.deliverAs === "followUp" ? "followUp" as const
                : data.deliverAs === "steer" ? "steer" as const
                : undefined;
            void (async () => {
                try {
                    const httpBase = rctx.relayHttpBaseUrl();
                    const key = rctx.apiKey();
                    const message = await buildUserMessageFromRemoteInput(inputText, attachments, httpBase, key ?? "");
                    pi.sendUserMessage(message as any, deliverAs ? { deliverAs } : undefined);
                } catch (err) {
                    console.error(`pizzapi: failed to deliver remote input: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        });

        sock.on("exec", (data) => {
            if (typeof data.id === "string" && typeof data.command === "string") {
                void handleExecFromWeb(data as any, rctx, {
                    setModelFromWeb,
                    markSessionNameBroadcasted: () => rctx.markSessionNameBroadcasted(),
                });
            }
        });

        sock.on("model_set", (data) => {
            void setModelFromWeb(data.provider, data.modelId);
        });

        sock.on("session_message", (data) => {
            messageBus.receive({
                fromSessionId: data.fromSessionId,
                message: data.message,
                ts: typeof data.ts === "string" ? data.ts : new Date().toISOString(),
            });
        });

        sock.on("session_trigger" as any, (data: { trigger: ConversationTrigger }) => {
            const trigger = data?.trigger;
            if (!trigger) return;

            // NOTE: We no longer auto-suppress session_complete triggers when
            // the parent has consumed messages from the child. Linked sessions
            // may mix send_message (for streaming updates) with trigger-based
            // completion — suppressing session_complete after any bus consumption
            // would cause the parent to miss the final completion signal. If a
            // parent doesn't want triggers, it should spawn with linked: false.
            trackReceivedTrigger(trigger.triggerId, trigger.sourceSessionId, trigger.type);
            const rendered = renderTrigger(trigger);
            const deliverAs = trigger.deliverAs === "followUp" ? "followUp" as const : "steer" as const;
            pi.sendUserMessage(rendered, { deliverAs });
        });

        sock.on("trigger_response" as any, (data: { triggerId: string; response: string; action?: string; targetSessionId?: string }) => {
            if (!data?.triggerId) return;
            const pending = receivedTriggers.get(data.triggerId);
            if (!pending || !rctx.relay || !rctx.sioSocket?.connected) return;
            rctx.sioSocket.emit("trigger_response" as any, {
                token: rctx.relay.token,
                triggerId: data.triggerId,
                response: data.response,
                ...(data.action ? { action: data.action } : {}),
                targetSessionId: pending.sourceSessionId,
            });
            receivedTriggers.delete(data.triggerId);
        });

        sock.on("session_expired", (_data: any) => {
            rctx.shuttingDown = true;
            rctx.relay = null;
            rctx.setRelayStatus("Session expired");
        });

        sock.on("connect_error", (_err) => {
            const url = socketIoUrl();
            rctx.setRelayStatus(`Relay connection failed (${url})`);

            if (!connectFailureNotified && rctx.latestCtx) {
                connectFailureNotified = true;
                rctx.latestCtx.ui.notify(
                    `⚠ Could not connect to relay at ${url}\n` +
                    "Sessions won't appear in the web UI until the connection is established.\n" +
                    "Check PIZZAPI_RELAY_URL or run `pizza setup` to reconfigure.",
                );
            }
        });

        sock.on("error", (data: any) => {
            rctx.setRelayStatus(`Relay error: ${data.message}`);
        });

        sock.on("disconnect", (_reason) => {
            rctx.relay = null;
            cancelPendingAskUserQuestion(rctx);
            cancelPendingPlanMode(rctx);
            rctx.setRelayStatus(rctx.disconnectedStatusText());
        });

        // ── MCP OAuth relay context ───────────────────────────────────────
        sock.on("connect", () => updateMcpRelayContext());
        sock.on("disconnect", () => {
            const bridge = getMcpBridge();
            bridge?.setRelayContext?.(null);
        });

        (sock as any).on("mcp_oauth_callback", (data: any) => {
            if (data && typeof data === "object" && typeof data.nonce === "string" && typeof data.code === "string") {
                const resolve = oauthPendingCallbacks.get(data.nonce);
                if (resolve) {
                    oauthPendingCallbacks.delete(data.nonce);
                    resolve(data.code);
                }
                const bridge = getMcpBridge();
                bridge?.deliverOAuthCallback?.(data.nonce, data.code);
            }
        });

        updateMcpRelayContext();
    }

    function disconnect() {
        stopHeartbeat();
        cancelPendingAskUserQuestion(rctx);
        cancelPendingPlanMode(rctx);
        messageBus.setSendFn(null);
        const bridge = getMcpBridge();
        bridge?.setRelayContext?.(null);
        if (rctx.sioSocket) {
            if (rctx.relay && rctx.sioSocket.connected) {
                rctx.sioSocket.emit("session_end", { sessionId: rctx.relay.sessionId, token: rctx.relay.token });
            }
            rctx.sioSocket.removeAllListeners();
            rctx.sioSocket.disconnect();
            rctx.sioSocket = null;
        }
        rctx.relay = null;
        rctx.setRelayStatus(rctx.disconnectedStatusText());
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
        connect();
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
        rctx.forwardEvent({ type: "session_active", state: rctx.buildSessionState() });
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    pi.on("turn_start", (event) => {
        sessionCompleteFired = false;
        clearFollowUpGrace();
        rctx.forwardEvent(event);
    });

    pi.on("session_shutdown", () => {
        rctx.shuttingDown = true;
        clearFollowUpGrace();
        stopHeartbeat();
        stopSessionNameSync();
        _ctx = null;
        fireSessionComplete();
        disconnect();
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
            fireSessionComplete(summary, fullOutputPath);
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
        rctx.forwardEvent({ type: "session_active", state: rctx.buildSessionState() });
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
                disconnect();
                ctx.ui.notify("Disconnected from relay.");
                return;
            }
            if (arg === "reconnect") {
                disconnect();
                rctx.shuttingDown = false;
                connect();
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
