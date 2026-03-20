/**
 * Socket.IO connection management for the PizzaPi relay.
 *
 * Manages the lifecycle of the Socket.IO connection, including connect,
 * disconnect, reconnection, and all server-to-client event handlers.
 */

import { io, type Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import { loadConfig } from "../../config.js";
import { RELAY_BACKOFF_DEFAULTS } from "../../backoff.js";
import { getMcpBridge } from "../mcp-bridge.js";
import { messageBus } from "../session-message-bus.js";
import { refreshAllUsage } from "../remote-provider-usage.js";
import { startHeartbeat, stopHeartbeat } from "../remote-heartbeat.js";
import { cancelPendingAskUserQuestion, consumePendingAskUserQuestionFromWeb } from "../remote-ask-user.js";
import { cancelPendingPlanMode, consumePendingPlanModeFromWeb } from "../remote-plan-mode.js";
import { normalizeRemoteInputAttachments, buildUserMessageFromRemoteInput } from "../remote-input.js";
import { handleExecFromWeb } from "../remote-exec-handler.js";
import { renderTrigger } from "../triggers/registry.js";
import { trackReceivedTrigger, receivedTriggers } from "../triggers/extension.js";
import type { ConversationTrigger } from "../triggers/types.js";
import type { RelayContext } from "../remote-types.js";
import { emitSessionActive } from "./chunked-delivery.js";
import { resetRelayRegistrationGate, signalRelayRegistered } from "./registration-gate.js";

// ── Module-level singletons (safe: one relay extension per process) ───────────

/** Tracks whether the connection-failure notification has been shown this session. */
let connectFailureNotified = false;

/** Pending OAuth callback resolvers, keyed by nonce. */
const oauthPendingCallbacks = new Map<string, (code: string) => void>();

// ── Dependency injection for factory-closure callbacks ────────────────────────

/**
 * Callbacks injected from the extension factory so that `connect` can call
 * back into the factory without creating a circular import.
 */
export interface ConnectionHandlers {
    /** Cancel any in-flight follow-up grace timer (called on new input). */
    clearFollowUpGrace: () => void;
    /** Change the active model (called from exec and model_set handlers). */
    setModelFromWeb: (provider: string, modelId: string) => Promise<void>;
    /** Deliver a user message to the agent (called from input and session_trigger handlers). */
    sendUserMessage: (message: unknown, options?: { deliverAs?: "followUp" | "steer" }) => void;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Normalise a relay URL so it always uses a WebSocket scheme.
 * Exported so that `relayHttpBaseUrl()` on RelayContext can use it.
 */
export function toWebSocketBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/$/, "");
    if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
    if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
    if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
    return `wss://${trimmed}`;
}

/**
 * Returns true when the relay has been explicitly disabled via config.
 * Setting PIZZAPI_RELAY_URL=off (case-insensitive) disables auto-connect.
 */
export function isDisabled(): boolean {
    const configured = process.env.PIZZAPI_RELAY_URL ?? loadConfig(process.cwd()).relayUrl ?? "";
    return configured.toLowerCase() === "off";
}

/** Resolve the Socket.IO base URL from the relay URL (ws→http, wss→https). */
function socketIoUrl(rctx: RelayContext): string {
    const explicit = process.env.PIZZAPI_SOCKETIO_URL;
    if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, "");
    const base = rctx.relayUrl();
    return base.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

// ── MCP relay context ──────────────────────────────────────────────────────────

/** Sync the MCP bridge's relay context with the current connection state. */
function updateMcpRelayContext(rctx: RelayContext): void {
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

// ── Socket.IO connection ───────────────────────────────────────────────────────

/**
 * Establish a Socket.IO connection to the relay and register all event handlers.
 * If a connection already exists it is torn down first.
 */
export function connect(rctx: RelayContext, handlers: ConnectionHandlers): void {
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

    const sioUrl = socketIoUrl(rctx);

    const sock: Socket<RelayServerToClientEvents, RelayClientToServerEvents> = io(
        sioUrl + "/relay",
        {
            auth: { apiKey: key },
            transports: ["websocket"],
            // Exponential backoff with ±25% jitter. Socket.IO doubles the
            // delay on each reconnection attempt (up to reconnectionDelayMax)
            // and applies randomizationFactor as a ±fraction of each delay.
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: RELAY_BACKOFF_DEFAULTS.baseMs,       // 1 s base
            reconnectionDelayMax: RELAY_BACKOFF_DEFAULTS.maxMs,     // 30 s cap
            randomizationFactor: RELAY_BACKOFF_DEFAULTS.jitterFactor, // ±25%
        },
    );
    rctx.sioSocket = sock;
    resetRelayRegistrationGate();

    // ── Connection lifecycle ──────────────────────────────────────────────

    sock.on("connect", () => {
        resetRelayRegistrationGate();
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

        emitSessionActive(rctx);
        void refreshAllUsage();
        startHeartbeat(rctx);
        updateMcpRelayContext(rctx);
        signalRelayRegistered();
    });

    // ── Incoming events from server ───────────────────────────────────────

    sock.on("event_ack", (data) => {
        if (rctx.relay && typeof data.seq === "number") {
            rctx.relay.ackedSeq = Math.max(rctx.relay.ackedSeq, data.seq);
        }
    });

    sock.on("connected", () => {
        rctx.forwardEvent(rctx.buildCapabilitiesState());
        emitSessionActive(rctx);
    });

    sock.on("input", (data) => {
        // Any new input cancels the follow-up grace period immediately
        // (don't wait for turn_start which is async).
        handlers.clearFollowUpGrace();

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
                const relaySessionId = rctx.relay?.sessionId;
                const message = await buildUserMessageFromRemoteInput(inputText, attachments, httpBase, key ?? "", relaySessionId);
                handlers.sendUserMessage(message, deliverAs ? { deliverAs } : undefined);
            } catch (err) {
                console.error(`pizzapi: failed to deliver remote input: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
    });

    sock.on("exec", (data) => {
        if (typeof data.id === "string" && typeof data.command === "string") {
            void handleExecFromWeb(data as any, rctx, {
                setModelFromWeb: handlers.setModelFromWeb,
                markSessionNameBroadcasted: () => rctx.markSessionNameBroadcasted(),
            });
        }
    });

    sock.on("model_set", (data) => {
        void handlers.setModelFromWeb(data.provider, data.modelId);
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
        // The trigger metadata line (<!-- trigger:ID source:SID questions64:... -->)
        // carries structured question data inline so the web UI can render
        // rich trigger cards. This keeps the agent-facing prompt clean —
        // no separate HTML comment block is needed.
        const deliverAs = trigger.deliverAs === "followUp" ? "followUp" as const : "steer" as const;
        handlers.sendUserMessage(rendered, { deliverAs });
    });

    sock.on("trigger_response" as any, (data: { triggerId: string; response: string; action?: string; targetSessionId?: string }) => {
        if (!data?.triggerId) return;
        const pending = receivedTriggers.get(data.triggerId);
        if (!pending || !rctx.relay || !rctx.sioSocket?.connected) return;

        // For session_complete triggers, handle cleanup the same way
        // as respond_to_trigger in the triggers extension — escalated
        // replies from the human viewer must also clean up the child.
        // Keep the trigger pending until delivery is confirmed so the
        // human can retry if it fails.
        if (pending.type === "session_complete") {
            const action = data.action ?? "ack";
            if (action === "followUp") {
                // Deliver follow-up as agent input to resume the child.
                // Keep the trigger pending if delivery fails so the human
                // can retry instead of losing the follow-up.
                const childId = pending.sourceSessionId;
                let failed = false;
                const onError = (err: { targetSessionId: string; error: string }) => {
                    if (err.targetSessionId === childId) {
                        failed = true;
                        rctx.sioSocket!.off("session_message_error" as any, onError);
                    }
                };
                rctx.sioSocket.on("session_message_error" as any, onError);
                rctx.sioSocket.emit("session_message", {
                    token: rctx.relay.token,
                    targetSessionId: childId,
                    message: data.response,
                    deliverAs: "input",
                });
                // After a short window without an error, consider delivery
                // successful and clear the trigger. On failure it stays
                // pending for retry.
                setTimeout(() => {
                    rctx.sioSocket?.off("session_message_error" as any, onError);
                    if (!failed) {
                        receivedTriggers.delete(data.triggerId);
                    }
                }, 3000);
            } else {
                // ack — emit cleanup request with ack callback
                rctx.sioSocket.emit("cleanup_child_session", {
                    token: rctx.relay.token,
                    childSessionId: pending.sourceSessionId,
                }, (result: { ok: boolean; error?: string }) => {
                    if (result?.ok) {
                        receivedTriggers.delete(data.triggerId);
                    }
                    // On failure, trigger stays — human can retry
                });
            }
            return;
        }

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
        const url = socketIoUrl(rctx);
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

    // ── MCP OAuth relay context ───────────────────────────────────────────
    sock.on("connect", () => updateMcpRelayContext(rctx));
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

    updateMcpRelayContext(rctx);
}

/**
 * Tear down the active Socket.IO connection cleanly.
 * Cancels any pending ask-user-question / plan-mode prompts, clears the
 * message bus send function, and emits `session_end` before disconnecting.
 */
export function disconnect(rctx: RelayContext): void {
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
