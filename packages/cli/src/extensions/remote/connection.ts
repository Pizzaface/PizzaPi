/**
 * Socket.IO connection management for the PizzaPi relay.
 *
 * Manages the lifecycle of the Socket.IO connection, including connect,
 * disconnect, reconnection, and all server-to-client event handlers.
 */

import { io, type Socket } from "socket.io-client";
import { SOCKET_PROTOCOL_VERSION, type RelayClientToServerEvents, type RelayServerToClientEvents } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import { loadConfig } from "../../config.js";
import { RELAY_BACKOFF_DEFAULTS, computeBackoffDelay } from "../../backoff.js";
import { getMcpBridge } from "../mcp-bridge.js";
import { messageBus } from "../session-message-bus.js";
import { refreshAllUsage } from "../remote-provider-usage.js";
import { startHeartbeat, stopHeartbeat } from "../remote-heartbeat.js";
import { emitAuthSourceChanged, emitThinkingLevelChanged, emitMcpStartupReport } from "../remote-meta-events.js";
import { getAuthSource } from "../remote-auth-source.js";
import { cancelPendingAskUserQuestion, consumePendingAskUserQuestionFromWeb } from "../remote-ask-user.js";
import { cancelPendingPlanMode, consumePendingPlanModeFromWeb } from "../remote-plan-mode.js";
import { normalizeRemoteInputAttachments, buildUserMessageFromRemoteInput } from "../remote-input.js";
import { handleExecFromWeb } from "../remote-exec-handler.js";
import { renderTrigger, renderTriggerBatch } from "../triggers/registry.js";
import { trackReceivedTrigger, receivedTriggers, sendTriggerResponseWithAck, markTriggerHandled } from "../triggers/extension.js";
import type { ConversationTrigger } from "../triggers/types.js";
import type { RelayContext } from "../remote-types.js";
import { emitSessionActive } from "./chunked-delivery.js";
import { resetRelayRegistrationGate, signalRelayRegistered } from "./registration-gate.js";
import { decideRegisteredParentState } from "../remote-registered-parent-state.js";
import { waitForWorkerStartupComplete } from "../worker-startup-gate.js";
import { resolveInputDeliverAs } from "./deliver-as-default.js";
import { sendSessionCompleteFollowUp } from "./session-complete-followup.js";

// ── Module-level singletons (safe: one relay extension per process) ───────────

/** Tracks whether the connection-failure notification has been shown this session. */
let connectFailureNotified = false;

/** Pending OAuth callback resolvers, keyed by nonce. */
const oauthPendingCallbacks = new Map<string, (result: { code: string; state?: string }) => void>();
const log = createLogger("relay");

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

    // ── Delink handlers (PR #176) ─────────────────────────────────────────
    /** Whether a delink_own_parent is pending (child did /new). */
    isPendingDelinkOwnParent: () => boolean;
    /** Set server clock offset from registered event's serverTime. */
    setServerClockOffset: (offset: number) => void;
    /** Check if a session_message sender is a known stale pre-/new child. */
    isStaleChild: (sessionId: string) => boolean;
    /** Get the stale parent ID for session_message filtering. */
    getStalePrimaryParentId: () => string | null;
    /** Parent explicitly delinked (wasDelinked=true in registered). */
    onParentExplicitlyDelinked: () => void;
    /** Parent transiently offline (Redis miss, no wasDelinked). */
    onParentTransientlyOffline: () => void;
    /** parent_delinked event received from server. */
    onParentDelinked: (ack?: (result: { ok: boolean }) => void) => void;
    /** Flush deferred delink_children + delink_own_parent + cancellations after reconnect. */
    flushDeferredDelinks: () => void;
    /** Called on disconnect to clean up delink timers. */
    onDelinkDisconnect: () => void;
    /** Called before socket teardown to stop cancellation retry loops. */
    onSocketTeardown: () => void;
    /** Compute parentSessionId for register (accounts for pendingDelinkOwnParent). */
    getParentSessionIdForRegister: () => string | null | undefined;
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
            waitForCallback: (nonce: string, timeoutMs: number = 120_000, signal?: AbortSignal) => {
                return new Promise<{ code: string; state?: string }>((resolve, reject) => {
                    const cleanup = () => {
                        oauthPendingCallbacks.delete(nonce);
                        clearTimeout(timer);
                        signal?.removeEventListener("abort", onAbort);
                    };
                    const timer = setTimeout(() => {
                        cleanup();
                        reject(new Error("OAuth callback timed out"));
                    }, timeoutMs);
                    const onAbort = () => {
                        cleanup();
                        reject(new DOMException("OAuth callback aborted", "AbortError"));
                    };
                    if (signal?.aborted) { cleanup(); reject(new DOMException("OAuth callback aborted", "AbortError")); return; }
                    signal?.addEventListener("abort", onAbort, { once: true });

                    oauthPendingCallbacks.set(nonce, (result) => {
                        cleanup();
                        resolve(result);
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
        handlers.onSocketTeardown();
        rctx.sioSocket.removeAllListeners();
        rctx.sioSocket.disconnect();
        rctx.sioSocket = null;
    }

    const sioUrl = socketIoUrl(rctx);
    log.info(`pizzapi: connecting to relay at ${sioUrl}/relay…`);

    const sock: Socket<RelayServerToClientEvents, RelayClientToServerEvents> = io(
        sioUrl + "/relay",
        {
            auth: {
                apiKey: key,
                protocolVersion: SOCKET_PROTOCOL_VERSION,
            },
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

    // ── Trigger batch queue ───────────────────────────────────────────────
    // When multiple linked child sessions finish (or send other triggers) at
    // nearly the same time they each emit a session_trigger event. Without
    // batching those events are delivered to the agent one at a time, causing
    // N separate conversation turns. We collect triggers that arrive within a
    // short window and flush them together as a single message.
    const TRIGGER_BATCH_DEBOUNCE_MS = 80;
    type BatchedTrigger = { trigger: ConversationTrigger; rendered: string; deliverAs: "followUp" | "steer" };
    let pendingTriggerBatch: BatchedTrigger[] = [];
    let triggerBatchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushTriggerBatch = () => {
        triggerBatchTimer = null;
        if (pendingTriggerBatch.length === 0) return;
        const batch = pendingTriggerBatch.splice(0);
        // Prefer "followUp" delivery if any trigger requested it; otherwise "steer".
        const deliverAs = batch.some((b) => b.deliverAs === "followUp") ? "followUp" as const : "steer" as const;
        const rendered = renderTriggerBatch(batch.map((b) => b.trigger));
        void (async () => {
            try {
                await waitForWorkerStartupComplete();
                handlers.sendUserMessage(rendered, { deliverAs });
            } catch (err) {
                log.error(`pizzapi: failed to deliver trigger batch: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
    };

    // ── Backoff / reconnection logging (Manager-level events) ─────────────
    //
    // Socket.IO's built-in exponential backoff handles all retry scheduling;
    // these listeners only add visibility into each attempt.

    sock.io.on("reconnect_attempt", (attempt: number) => {
        // attempt is 1-indexed; computeBackoffDelay expects a 0-indexed count,
        // so pass (attempt - 1) to mirror Socket.IO's own delay calculation.
        const approxDelayMs = computeBackoffDelay(attempt - 1);
        const delaySec = (approxDelayMs / 1000).toFixed(1);
        rctx.setRelayStatus(`Reconnecting to relay… (attempt ${attempt})`);
        log.info(`pizzapi: relay reconnect attempt ${attempt} — retrying in ~${delaySec}s`);
    });

    sock.io.on("reconnect", (attempt: number) => {
        log.info(
            `pizzapi: relay reconnected after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
        );
    });

    sock.io.on("reconnect_error", (err: Error) => {
        log.info(`pizzapi: relay reconnect error — ${err?.message ?? String(err)}`);
    });

    // ── Connection lifecycle ──────────────────────────────────────────────

    sock.on("connect", () => {
        resetRelayRegistrationGate();
        const parentSessionIdForRegister = handlers.getParentSessionIdForRegister();
        sock.emit("register", {
            sessionId: rctx.relaySessionId,
            cwd: process.cwd(),
            ephemeral: true,
            collabMode: true,
            sessionName: rctx.getCurrentSessionName() ?? undefined,
            ...(parentSessionIdForRegister === undefined ? {} : { parentSessionId: parentSessionIdForRegister }),
        });
    });

    sock.on("registered", (data) => {
        const wasReconnect = connectFailureNotified;
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
        log.info(
            wasReconnect
                ? `pizzapi: relay reconnected — session ${data.sessionId} (${data.shareUrl})`
                : `pizzapi: relay connected — session ${data.sessionId} (${data.shareUrl})`,
        );

        // Update server clock offset for epoch calculations.
        if (typeof data.serverTime === "number") {
            handlers.setServerClockOffset(data.serverTime - Date.now());
        }
        rctx.supportsSessionTriggerAck = data.supportsSessionTriggerAck === true;

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

        const parentStateDecision = decideRegisteredParentState({
            serverParentSessionId: data.parentSessionId,
            localParentSessionId: rctx.parentSessionId,
            pendingDelinkOwnParent: handlers.isPendingDelinkOwnParent(),
            wasDelinked: data.wasDelinked,
        });

        switch (parentStateDecision.kind) {
            case "link":
                rctx.parentSessionId = parentStateDecision.parentSessionId;
                rctx.isChildSession = true;
                log.info(`pizzapi: linked as child of parent session ${parentStateDecision.parentSessionId}`);
                break;
            case "ignore_stale_server_link":
                // The child ran /new while disconnected — don't restore the
                // stale parent link from Redis.
                log.info("pizzapi: ignoring stale parentSessionId from server (pendingDelinkOwnParent)");
                rctx.parentSessionId = null;
                rctx.isChildSession = false;
                break;
            case "explicit_delink":
                handlers.onParentExplicitlyDelinked();
                break;
            case "transient_offline":
                handlers.onParentTransientlyOffline();
                break;
            case "no_change":
                break;
        }

        emitSessionActive(rctx);
        void refreshAllUsage();
        startHeartbeat(rctx);

        // Emit initial meta values so late-joining viewers get current state.
        const authSource = getAuthSource(rctx.latestCtx);
        if (authSource) emitAuthSourceChanged(rctx, authSource);
        const thinkingLevel = rctx.getCurrentThinkingLevel();
        if (thinkingLevel) emitThinkingLevelChanged(rctx, thinkingLevel);

        updateMcpRelayContext(rctx);
        signalRelayRegistered();

        // Flush deferred delinks and cancellations after reconnect.
        handlers.flushDeferredDelinks();
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
        // While waiting for delink_own_parent to be confirmed by the server,
        // the old parent can still inject tell_child / follow-up input.
        // Drop agent-originated input until the server-side link is severed.
        if (handlers.isPendingDelinkOwnParent() && (data as any).client === "agent") {
            log.info("pizzapi: dropping stale parent tell_child/follow-up input — delink_own_parent pending");
            return;
        }

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
                await waitForWorkerStartupComplete();
                // Defensive: if the gate was held open by slow MCP startup, the
                // initial prompt (or another buffered message) may have already
                // started streaming by the time we resume here. See
                // resolveInputDeliverAs for the rationale.
                const effectiveDeliverAs = resolveInputDeliverAs(deliverAs, rctx.isAgentActive === true);
                handlers.sendUserMessage(message, effectiveDeliverAs ? { deliverAs: effectiveDeliverAs } : undefined);
            } catch (err) {
                log.error(`pizzapi: failed to deliver remote input: ${err instanceof Error ? err.message : String(err)}`);
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
        // Drop session_messages only from senders we know are pre-/new children.
        if (handlers.isStaleChild(data.fromSessionId)) {
            log.info(`pizzapi: dropping stale session_message from ${data.fromSessionId} — sender is a pre-/new child`);
            return;
        }
        // Drop stale send_message traffic from old parent during pending delink.
        const stalePrimary = handlers.getStalePrimaryParentId();
        if (handlers.isPendingDelinkOwnParent() && stalePrimary && data.fromSessionId === stalePrimary) {
            log.info(`pizzapi: dropping stale session_message from old parent ${data.fromSessionId} — delink_own_parent pending`);
            return;
        }
        messageBus.receive({
            fromSessionId: data.fromSessionId,
            message: data.message,
            ts: typeof data.ts === "string" ? data.ts : new Date().toISOString(),
        });
    });

    sock.on("session_trigger" as any, (data: { trigger: ConversationTrigger }) => {
        const trigger = data?.trigger;
        if (!trigger) return;
        // Drop triggers from known pre-/new children.
        if (handlers.isStaleChild(trigger.sourceSessionId)) {
            log.info(`dropping stale session_trigger (${trigger.type}) from ${trigger.sourceSessionId} — sender is a pre-/new child`);
            return;
        }

        // NOTE: We no longer auto-suppress session_complete triggers when
        // the parent has consumed messages from the child. Linked sessions
        // may mix send_message (for streaming updates) with trigger-based
        // completion — suppressing session_complete after any bus consumption
        // would cause the parent to miss the final completion signal. If a
        // parent doesn't want triggers, it should spawn with linked: false.
        const tracked = trackReceivedTrigger(trigger.triggerId, trigger.sourceSessionId, trigger.type);
        if (!tracked) {
            log.info(`dropping duplicate session_trigger (${trigger.type}) ${trigger.triggerId}`);
            return;
        }
        const rendered = renderTrigger(trigger);
        const deliverAs = trigger.deliverAs === "followUp" ? "followUp" as const : "steer" as const;

        // Enqueue and debounce: triggers that arrive within the batch window are
        // flushed together as a single agent message (see flushTriggerBatch above).
        pendingTriggerBatch.push({ trigger, rendered, deliverAs });
        if (triggerBatchTimer !== null) clearTimeout(triggerBatchTimer);
        triggerBatchTimer = setTimeout(flushTriggerBatch, TRIGGER_BATCH_DEBOUNCE_MS);
    });

    sock.on("trigger_response" as any, (data: { triggerId: string; response: string; action?: string; targetSessionId?: string }) => {
        if (!data?.triggerId) return;
        const pending = receivedTriggers.get(data.triggerId);
        if (!pending || !rctx.relay || !rctx.sioSocket?.connected) return;

        if (pending.type === "session_complete") {
            const action = data.action ?? "ack";
            if (action === "followUp") {
                const childId = pending.sourceSessionId;
                void sendSessionCompleteFollowUp({
                    socket: rctx.sioSocket,
                    token: rctx.relay.token,
                    childSessionId: childId,
                    message: data.response,
                }).then((result) => {
                    if (result.ok) {
                        markTriggerHandled(data.triggerId);
                    }
                });
            } else {
                rctx.sioSocket.emit("cleanup_child_session", {
                    token: rctx.relay.token,
                    childSessionId: pending.sourceSessionId,
                }, (result: { ok: boolean; error?: string }) => {
                    if (result?.ok) {
                        markTriggerHandled(data.triggerId);
                    }
                });
            }
            return;
        }

        void sendTriggerResponseWithAck({ socket: rctx.sioSocket, token: rctx.relay.token }, {
            triggerId: data.triggerId,
            response: data.response,
            action: data.action,
            targetSessionId: pending.sourceSessionId,
        }).then((result) => {
            if (result.ok) {
                markTriggerHandled(data.triggerId);
                return;
            }
            log.info(`pizzapi: failed to deliver trigger response ${data.triggerId}: ${result.error ?? "unknown error"}`);
            rctx.latestCtx?.ui.notify(
                `⚠ Failed to deliver trigger response ${data.triggerId}: ${result.error ?? "unknown error"}\n` +
                "The linked parent/child relationship may be broken or stale. The trigger has been kept so it can be retried or escalated.",
            );
        });
    });

    sock.on("session_expired", (_data: any) => {
        rctx.shuttingDown = true;
        rctx.relay = null;
        rctx.setRelayStatus("Session expired");
    });

    // ── parent_delinked — parent started a new session ───────────────
    sock.on("parent_delinked", (_data: any, ack?: (result: { ok: boolean }) => void) => {
        handlers.onParentDelinked(ack);
    });

    sock.on("connect_error", (err) => {
        const url = socketIoUrl(rctx);
        const reason = err?.message ?? String(err);
        rctx.setRelayStatus(`Relay connection failed (${url})`);
        log.info(`pizzapi: relay connection error — ${reason}`);

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
        // Discard any pending batched triggers — don't deliver them after disconnect.
        if (triggerBatchTimer !== null) { clearTimeout(triggerBatchTimer); triggerBatchTimer = null; }
        pendingTriggerBatch = [];
        handlers.onDelinkDisconnect();
        rctx.relay = null;
        cancelPendingAskUserQuestion(rctx);
        cancelPendingPlanMode(rctx);
        rctx.setRelayStatus(rctx.disconnectedStatusText());
    });

    // ── MCP OAuth relay context ───────────────────────────────────────
    sock.on("connect", () => updateMcpRelayContext(rctx));
    sock.on("disconnect", () => {
        const bridge = getMcpBridge();
        bridge?.setRelayContext?.(null);
    });

    (sock as any).on("mcp_oauth_callback", (data: any) => {
        if (data && typeof data === "object" && typeof data.nonce === "string" && typeof data.code === "string") {
            // Accept both "state" (new) and "oauthState" (server relay route) field names
            const state = typeof data.state === "string" ? data.state
                : typeof data.oauthState === "string" ? data.oauthState
                : undefined;
            const resolve = oauthPendingCallbacks.get(data.nonce);
            if (resolve) {
                oauthPendingCallbacks.delete(data.nonce);
                resolve({ code: data.code, state });
            }
            const bridge = getMcpBridge();
            bridge?.deliverOAuthCallback?.(data.nonce, data.code);
        }
    });

    // Paste mode: user pasted the OAuth callback URL in the web UI.
    // Payload includes nonce, code, and optionally state from the pasted URL.
    (sock as any).on("mcp_oauth_paste", (data: any) => {
        if (data && typeof data === "object" && typeof data.nonce === "string" && typeof data.code === "string") {
            const state = typeof data.state === "string" ? data.state : undefined;
            const resolve = oauthPendingCallbacks.get(data.nonce);
            if (resolve) {
                oauthPendingCallbacks.delete(data.nonce);
                resolve({ code: data.code, state });
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
export function disconnect(rctx: RelayContext, handlers?: ConnectionHandlers): void {
    stopHeartbeat();
    handlers?.onSocketTeardown();
    handlers?.onDelinkDisconnect();
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
