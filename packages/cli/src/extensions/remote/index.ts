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
import { setTodoUpdateCallback, setTodoMetaEmitter, type TodoItem } from "../update-todo.js";
import { getCurrentTodoList } from "../update-todo.js";
import { setPlanModeChangeCallback, setPlanModeMetaEmitter } from "../plan-mode-toggle.js";
import type { RemoteExecResponse } from "../remote-commands.js";
import { clearAndCancelPendingTriggers } from "../triggers/extension.js";
import type { ConversationTrigger } from "../triggers/types.js";
import type { Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import type {
    RelayContext,
    RelayModelInfo,
    TriggerResponse,
} from "../remote-types.js";
import { installFooter } from "../remote-footer.js";
import { buildHeartbeat, buildTokenUsage, stopHeartbeat } from "../remote-heartbeat.js";
import { maybeFireSessionError } from "./session-error-trigger.js";
import {
    emitTodoUpdated, emitPlanModeToggled,
    emitRetryStateChanged, emitPluginTrustRequired, emitPluginTrustResolved,
    emitTokenUsageUpdated, emitModelChanged, emitAuthSourceChanged,
    emitMcpStartupReport, emitCompactStarted, emitCompactEnded,
} from "../remote-meta-events.js";
import { getAuthSource } from "../remote-auth-source.js";
import { buildProviderUsage } from "../remote-provider-usage.js";
import { registerAskUserTool } from "../remote-ask-user.js";
import { registerPlanModeTool } from "../remote-plan-mode.js";
import { createTriggerWaitManager } from "../trigger-wait-manager.js";
import { isCancelTriggerAction } from "../remote-trigger-response.js";
import { evaluateDelinkChildrenAck, evaluateDelinkOwnParentAck } from "../remote-delink-retry.js";
import { receivedTriggers } from "../triggers/extension.js";

// ── Sub-modules ───────────────────────────────────────────────────────────────
import { emitSessionActive, estimateMessagesSize, needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries } from "./chunked-delivery.js";
import { waitForRelayRegistrationGated } from "./registration-gate.js";
import { connect, disconnect, isDisabled, toWebSocketBaseUrl, type ConnectionHandlers } from "./connection.js";

// Re-export chunked-delivery utilities so existing importers (e.g. tests) that
// import from the top-level `remote.js` barrel continue to work unchanged.
export { estimateMessagesSize, needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries };

const RELAY_DEFAULT = "ws://localhost:7492";
const RELAY_STATUS_KEY = "relay";
const TRIGGER_CANCELLATION_RETRY_INTERVAL_MS = 3_000;

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
    let sessionErrorFired = false;
    // Set when /new fires so we can retry delink_children on reconnect if
    // the initial emit is lost.  Cleared by the server ack callback.
    let pendingDelink = false;
    let pendingDelinkRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingDelinkRetryEpoch: number | null = null;
    let pendingDelinkEpoch: number | null = null;
    const staleChildIds = new Set<string>();
    let pendingDelinkOwnParent = false;
    let pendingDelinkOwnParentRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let stalePrimaryParentId: string | null = null;
    let pendingCancellations: Array<{ triggerId: string; childSessionId: string }> = [];
    let pendingCancellationRetryTimer: ReturnType<typeof setInterval> | null = null;
    let pendingCancellationRetryInFlight = false;
    const triggerWaits = createTriggerWaitManager();
    let followUpGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let followUpGraceShutdown: (() => void) | null = null;
    let sessionNameSyncTimer: ReturnType<typeof setInterval> | null = null;
    let lastBroadcastSessionName: string | null = null;
    let serverClockOffset = 0;

    // ── delink_children emit helper ────────────────────────────────────────
    const DELINK_RETRY_DELAY_MS = 3_000;

    function clearPendingDelinkRetryTimer(epoch?: number | null): void {
        if (pendingDelinkRetryTimer === null) return;
        if (epoch !== undefined && epoch !== null && pendingDelinkRetryEpoch !== epoch) return;
        clearTimeout(pendingDelinkRetryTimer);
        pendingDelinkRetryTimer = null;
        pendingDelinkRetryEpoch = null;
    }

    function emitDelinkChildren(rawEpoch: number): void {
        if (!rctx.relay || !rctx.sioSocket?.connected) return;
        rctx.sioSocket.emit("delink_children", {
            token: rctx.relay.token,
            epoch: rawEpoch + serverClockOffset,
        }, (result: { ok: boolean; error?: string }) => {
            const plan = evaluateDelinkChildrenAck({
                ackEpoch: rawEpoch,
                pendingEpoch: pendingDelinkEpoch,
                retryEpoch: pendingDelinkRetryEpoch,
                ok: result?.ok,
                connected: Boolean(rctx.sioSocket?.connected),
            });

            if (plan.ignoreAck) {
                console.log("pizzapi: ignoring stale delink_children ack (superseded by a later /new)");
                if (plan.clearRetryTimer) clearPendingDelinkRetryTimer(rawEpoch);
                return;
            }

            if (plan.scheduleRetry) {
                console.log(`pizzapi: delink_children server error: ${result?.error ?? "unknown"} — scheduling retry in ${DELINK_RETRY_DELAY_MS}ms`);
                if (plan.clearRetryTimer) clearPendingDelinkRetryTimer(rawEpoch);
                pendingDelinkRetryEpoch = rawEpoch;
                pendingDelinkRetryTimer = setTimeout(() => {
                    pendingDelinkRetryTimer = null;
                    pendingDelinkRetryEpoch = null;
                    if (pendingDelinkEpoch === rawEpoch && rctx.sioSocket?.connected) {
                        console.log("pizzapi: retrying delink_children after server error");
                        emitDelinkChildren(rawEpoch);
                    }
                }, DELINK_RETRY_DELAY_MS);
                return;
            }

            if (plan.clearRetryTimer) clearPendingDelinkRetryTimer(rawEpoch);
            if (!plan.clearPendingDelink) return;
            pendingDelink = false;
            pendingDelinkEpoch = null;
            staleChildIds.clear();
        });
    }

    function clearPendingDelinkOwnParentRetryTimer(): void {
        if (pendingDelinkOwnParentRetryTimer === null) return;
        clearTimeout(pendingDelinkOwnParentRetryTimer);
        pendingDelinkOwnParentRetryTimer = null;
    }

    function emitDelinkOwnParent(): void {
        if (!pendingDelinkOwnParent || !rctx.relay || !rctx.sioSocket?.connected) return;
        rctx.sioSocket.emit(
            "delink_own_parent",
            { token: rctx.relay.token, oldParentId: stalePrimaryParentId },
            (result: { ok: boolean; error?: string }) => {
                const plan = evaluateDelinkOwnParentAck({
                    ok: result?.ok,
                    pending: pendingDelinkOwnParent,
                    connected: Boolean(rctx.sioSocket?.connected),
                });

                if (plan.confirmed) {
                    clearPendingDelinkOwnParentRetryTimer();
                    pendingDelinkOwnParent = false;
                    stalePrimaryParentId = null;
                    console.log("pizzapi: delink_own_parent confirmed by server");
                    return;
                }

                if (!plan.scheduleRetry) return;
                console.log(`pizzapi: delink_own_parent server error: ${result?.error ?? "unknown"} — scheduling retry in ${DELINK_RETRY_DELAY_MS}ms`);
                clearPendingDelinkOwnParentRetryTimer();
                pendingDelinkOwnParentRetryTimer = setTimeout(() => {
                    pendingDelinkOwnParentRetryTimer = null;
                    if (pendingDelinkOwnParent && rctx.sioSocket?.connected) {
                        console.log("pizzapi: retrying delink_own_parent after server error");
                        emitDelinkOwnParent();
                    }
                }, DELINK_RETRY_DELAY_MS);
            },
        );
    }

    // ── Cancellation retry loop ───────────────────────────────────────────

    function stopPendingCancellationRetryLoop() {
        if (pendingCancellationRetryTimer !== null) {
            clearInterval(pendingCancellationRetryTimer);
            pendingCancellationRetryTimer = null;
        }
        pendingCancellationRetryInFlight = false;
    }

    function startPendingCancellationRetryLoop() {
        if (pendingCancellationRetryTimer !== null) return;
        pendingCancellationRetryTimer = setInterval(() => {
            void retryPendingTriggerCancellations("periodic");
        }, TRIGGER_CANCELLATION_RETRY_INTERVAL_MS);
    }

    function retryPendingTriggerCancellations(reason: string) {
        if (pendingCancellations.length === 0) {
            stopPendingCancellationRetryLoop();
            return;
        }
        if (!rctx.relay || !rctx.sioSocket?.connected) return;
        if (pendingCancellationRetryInFlight) return;

        pendingCancellationRetryInFlight = true;
        const token = rctx.relay.token;
        const cancellationsToRetry = [...pendingCancellations];
        let successfulCancellations = 0;
        let failedCancellations = 0;
        let completedResponses = 0;
        let finished = false;

        const finishBatch = () => {
            if (finished) return;
            finished = true;
            pendingCancellationRetryInFlight = false;
            if (pendingCancellations.length === 0) {
                stopPendingCancellationRetryLoop();
            }
        };

        const timeout = setTimeout(() => {
            if (finished) return;
            const missing = cancellationsToRetry.length - completedResponses;
            failedCancellations += missing;
            console.log(`pizzapi: trigger cancellation retry timed out (${missing} ack callback(s) missing) — will retry`);
            finishBatch();
        }, 10_000);

        console.log(`pizzapi: retrying ${cancellationsToRetry.length} deferred trigger cancellation(s) (${reason})`);

        for (const { triggerId, childSessionId } of cancellationsToRetry) {
            rctx.sioSocket.emit("trigger_response" as any, {
                token,
                triggerId,
                response: "Parent started a new session — trigger cancelled.",
                action: "cancel",
                targetSessionId: childSessionId,
            }, (result: { ok: boolean; error?: string }) => {
                if (finished) return;
                completedResponses++;

                if (result?.ok) {
                    successfulCancellations++;
                    const index = pendingCancellations.findIndex(
                        (c) => c.triggerId === triggerId && c.childSessionId === childSessionId,
                    );
                    if (index >= 0) {
                        pendingCancellations.splice(index, 1);
                    }
                } else {
                    failedCancellations++;
                    console.log(`pizzapi: trigger cancellation failed for ${triggerId}: ${result?.error ?? "unknown"} — will retry`);
                }

                if (completedResponses === cancellationsToRetry.length) {
                    clearTimeout(timeout);
                    console.log(`pizzapi: trigger cancellation retry complete: ${successfulCancellations} succeeded, ${failedCancellations} failed`);
                    finishBatch();
                }
            });
        }
    }

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
                const expectedParentSessionId = rctx.parentSessionId;
                let settled = false;
                let unregisterWait = () => {};

                const finish = (result: TriggerResponse) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(result);
                };

                const timeout = setTimeout(() => {
                    finish({ response: "Trigger timed out — no response from parent within 5 minutes.", cancelled: true });
                }, timeoutMs);

                const handler = (data: { triggerId: string; response: string; action?: string }) => {
                    if (data.triggerId === triggerId) {
                        finish({
                            response: data.response,
                            action: data.action,
                            cancelled: isCancelTriggerAction(data.action),
                        });
                    }
                };

                const errorHandler = (data: { targetSessionId: string; error: string }) => {
                    if (expectedParentSessionId && data.targetSessionId === expectedParentSessionId) {
                        finish({ response: `Trigger delivery failed: ${data.error}`, cancelled: true });
                    }
                };

                const abortHandler = () => {
                    finish({ response: "Aborted", cancelled: true });
                };

                const cleanup = () => {
                    clearTimeout(timeout);
                    unregisterWait();
                    rctx.sioSocket?.off("trigger_response" as any, handler);
                    rctx.sioSocket?.off("session_message_error" as any, errorHandler);
                    signal?.removeEventListener("abort", abortHandler);
                };

                unregisterWait = triggerWaits.register(triggerId, finish);
                rctx.sioSocket!.on("trigger_response" as any, handler);
                rctx.sioSocket!.on("session_message_error" as any, errorHandler);
                signal?.addEventListener("abort", abortHandler);
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

    setTodoMetaEmitter((list) => emitTodoUpdated(rctx, list as any));

    setPlanModeChangeCallback((_enabled: boolean) => {
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    setPlanModeMetaEmitter((enabled) => emitPlanModeToggled(rctx, enabled));

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
                emitModelChanged(rctx, rctx.latestCtx?.model
                    ? { provider: rctx.latestCtx.model.provider, id: rctx.latestCtx.model.id,
                        name: rctx.latestCtx.model.name, reasoning: rctx.latestCtx.model.reasoning }
                    : null);
                emitAuthSourceChanged(rctx, getAuthSource(rctx.latestCtx));
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
        followUpGraceShutdown = null;
    }

    /** Trigger an immediate shutdown if the follow-up grace timer is running. */
    function shutdownFollowUpGraceImmediately() {
        if (followUpGraceShutdown) {
            const shutdown = followUpGraceShutdown;
            clearFollowUpGrace();
            console.log("pizzapi: parent delinked while follow-up grace active — shutting down immediately");
            shutdown();
        }
    }

    function startFollowUpGrace(ctx: { shutdown: () => void }) {
        clearFollowUpGrace();
        followUpGraceShutdown = ctx.shutdown;
        console.log(`pizzapi: waiting ${FOLLOWUP_GRACE_MS / 1000}s for parent follow-up before shutting down`);
        followUpGraceTimer = setTimeout(() => {
            followUpGraceTimer = null;
            followUpGraceShutdown = null;
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

    const connectionHandlers: ConnectionHandlers = {
        clearFollowUpGrace,
        setModelFromWeb,
        sendUserMessage: (msg: unknown, opts?: { deliverAs?: "followUp" | "steer" }) =>
            pi.sendUserMessage(msg as any, opts),

        // ── Delink handlers ───────────────────────────────────────────────
        isPendingDelinkOwnParent: () => pendingDelinkOwnParent,
        setServerClockOffset: (offset: number) => { serverClockOffset = offset; },
        isStaleChild: (sessionId: string) => staleChildIds.has(sessionId),
        getStalePrimaryParentId: () => stalePrimaryParentId,

        onParentExplicitlyDelinked: () => {
            const cancelledWaits = triggerWaits.cancelAll("Parent started a new session — trigger cancelled.");
            if (cancelledWaits > 0) {
                console.log(`pizzapi: parent explicitly delinked (wasDelinked) — cancelled ${cancelledWaits} pending trigger wait(s)`);
            }
            shutdownFollowUpGraceImmediately();
            console.log(`pizzapi: parent explicitly delinked — clearing parent link permanently`);
            rctx.parentSessionId = null;
            rctx.isChildSession = false;
        },

        onParentTransientlyOffline: () => {
            console.log(`pizzapi: parent temporarily offline (${rctx.parentSessionId}) — preserving parent link and child mode for reconnect`);
        },

        onParentDelinked: (ack?: (result: { ok: boolean }) => void) => {
            if (rctx.isChildSession) {
                const cancelled = triggerWaits.cancelAll("Parent started a new session — trigger cancelled.");
                console.log(`pizzapi: parent delinked — this session is no longer a child${cancelled > 0 ? ` — cancelled ${cancelled} pending trigger wait(s)` : ""}`);
                rctx.parentSessionId = null;
                rctx.isChildSession = false;
                shutdownFollowUpGraceImmediately();
            }
            ack?.({ ok: true });
        },

        flushDeferredDelinks: () => {
            if (pendingDelink && pendingDelinkEpoch !== null && rctx.sioSocket?.connected) {
                emitDelinkChildren(pendingDelinkEpoch);
                console.log("pizzapi: flushed deferred delink_children after reconnect");
            }
            if (pendingDelinkOwnParent && rctx.sioSocket?.connected) {
                emitDelinkOwnParent();
                console.log("pizzapi: flushed deferred delink_own_parent after reconnect");
            }
            if (pendingCancellations.length > 0 && rctx.sioSocket?.connected) {
                startPendingCancellationRetryLoop();
                retryPendingTriggerCancellations("registered");
            }
        },

        onDelinkDisconnect: () => {
            stopPendingCancellationRetryLoop();
            clearPendingDelinkRetryTimer();
            clearPendingDelinkOwnParentRetryTimer();
        },

        onSocketTeardown: () => {
            stopPendingCancellationRetryLoop();
        },

        getParentSessionIdForRegister: () => {
            return rctx.parentSessionId ?? (pendingDelinkOwnParent ? null : undefined);
        },
    };

    function doConnect() {
        connect(rctx, connectionHandlers);
    }

    function doDisconnect() {
        disconnect(rctx, connectionHandlers);
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

    pi.on("session_switch", (event, ctx) => {
        rctx.latestCtx = ctx;
        rctx.sessionStartedAt = Date.now();
        rctx.isAgentActive = false;

        // ── /new cleanup: cancel pending triggers and delink children ─────
        if (event.reason === "new") {
            staleChildIds.clear();
            for (const entry of receivedTriggers.values()) {
                staleChildIds.add(entry.sourceSessionId);
            }
            for (const { childSessionId } of pendingCancellations) {
                staleChildIds.add(childSessionId);
            }

            const { cancelled, sent, failed } = clearAndCancelPendingTriggers(
                (confirmedTriggerId, confirmedChildSessionId) => {
                    const idx = pendingCancellations.findIndex(
                        (c) => c.triggerId === confirmedTriggerId && c.childSessionId === confirmedChildSessionId,
                    );
                    if (idx >= 0) {
                        pendingCancellations.splice(idx, 1);
                        console.log(`pizzapi: trigger cancellation confirmed for ${confirmedTriggerId} — removed from retry queue`);
                        if (pendingCancellations.length === 0) {
                            stopPendingCancellationRetryLoop();
                        }
                    }
                },
            );
            if (cancelled > 0) {
                console.log(`pizzapi: cancelled ${cancelled} pending trigger(s) on session switch (${sent.length} sent-pending-ack, ${failed.length} deferred)`);
            }

            const allNeedingConfirmation = [...sent, ...failed];
            if (allNeedingConfirmation.length > 0) {
                pendingCancellations = [...pendingCancellations, ...allNeedingConfirmation];
                for (const { childSessionId } of allNeedingConfirmation) {
                    staleChildIds.add(childSessionId);
                }
                if (rctx.relay && rctx.sioSocket?.connected) {
                    startPendingCancellationRetryLoop();
                }
            }

            const rawDelinkEpoch = Date.now();
            pendingDelink = true;
            pendingDelinkEpoch = rawDelinkEpoch;
            clearPendingDelinkRetryTimer();
            if (rctx.relay && rctx.sioSocket?.connected) {
                emitDelinkChildren(rawDelinkEpoch);
            }

            if (rctx.isChildSession) {
                const cancelledChild = triggerWaits.cancelAll("Session switched — parent link cleared.");
                console.log(`pizzapi: clearing own parent link on /new${cancelledChild > 0 ? ` — cancelled ${cancelledChild} pending trigger wait(s)` : ""}`);
                pendingDelinkOwnParent = true;
                clearPendingDelinkOwnParentRetryTimer();
                stalePrimaryParentId = rctx.parentSessionId;
                if (rctx.relay && rctx.sioSocket?.connected) {
                    emitDelinkOwnParent();
                }
                rctx.parentSessionId = null;
                rctx.isChildSession = false;
                clearFollowUpGrace();
            }
        }

        sessionCompleteFired = false;

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
        sessionErrorFired = false;
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
        const shutdownExitReason = rctx.wasAborted ? "killed" : rctx.lastRetryableError ? "error" : "completed";
        fireSessionComplete(undefined, undefined, shutdownExitReason);
        doDisconnect();
    });

    // ── Agent lifecycle events ────────────────────────────────────────────

    pi.on("agent_start", (event) => {
        rctx.isAgentActive = true;
        rctx.lastRetryableError = null;
        emitRetryStateChanged(rctx, null);
        rctx.forwardEvent(event);
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    pi.on("agent_end", (event, ctx) => {
        rctx.isAgentActive = false;
        const lastError = rctx.lastRetryableError;
        rctx.lastRetryableError = null;
        emitRetryStateChanged(rctx, null);
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
            const exitReason = rctx.wasAborted ? "killed" : lastError ? "error" : "completed";
            fireSessionComplete(summary, fullOutputPath, exitReason);
            // Fire session_error for terminal usage-limit errors (one-shot, only at agent_end)
            if (maybeFireSessionError({
                sessionErrorFired,
                errorMessage: lastError?.errorMessage,
                isChildSession: rctx.isChildSession,
                parentSessionId: rctx.parentSessionId,
                socketConnected: rctx.sioSocket?.connected ?? false,
                emitFn: rctx.sioSocket
                    ? (event, payload) => (rctx.sioSocket as any).emit(event, payload)
                    : null,
                relayToken: rctx.relay?.token,
                relaySessionId: rctx.relay?.sessionId,
            })) {
                sessionErrorFired = true;
            }
            if (rctx.isChildSession) {
                startFollowUpGrace(ctx);
            }
        }
    });

    pi.on("turn_end", (event) => {
        rctx.forwardEvent(event);
        const tokenUsage = buildTokenUsage(rctx);
        const providerUsage = buildProviderUsage();
        emitTokenUsageUpdated(rctx, tokenUsage as any, providerUsage as any);
    });
    pi.on("message_start", (event) => rctx.forwardEvent(event));
    pi.on("message_update", (event) => rctx.forwardEvent(event));
    pi.on("message_end", (event) => {
        rctx.forwardEvent(event);
        const msg = (event as any).message;
        if (msg && msg.role === "assistant") {
            if (msg.stopReason === "error" && msg.errorMessage) {
                const errorText = String(msg.errorMessage);
                rctx.lastRetryableError = { errorMessage: errorText, detectedAt: Date.now() };
                emitRetryStateChanged(rctx, rctx.lastRetryableError);
                rctx.forwardEvent({ type: "cli_error", message: errorText, source: "provider", ts: Date.now() });
                rctx.forwardEvent(rctx.buildHeartbeat());
            } else if (msg.stopReason !== "error" && rctx.lastRetryableError) {
                // Agent recovered successfully after a retryable error — clear
                // the latch so we don't report a false-positive error exit.
                rctx.lastRetryableError = null;
                emitRetryStateChanged(rctx, null);
            }
        }
    });
    pi.on("tool_execution_start", (event) => rctx.forwardEvent(event));
    pi.on("tool_execution_update", (event) => rctx.forwardEvent(event));
    pi.on("tool_execution_end", (event) => rctx.forwardEvent(event));
    pi.on("model_select", (event) => {
        rctx.forwardEvent(event);
        emitAuthSourceChanged(rctx, getAuthSource(rctx.latestCtx));
        emitSessionActive(rctx);
    });

    // ── Compaction lifecycle (covers CLI /compact, auto-compact, and web-triggered) ──

    pi.on("session_before_compact", () => {
        // Only emit if not already tracked (web-triggered compacts set this
        // flag in the exec handler before calling ctx.compact()).
        if (!rctx.isCompacting) {
            rctx.isCompacting = true;
            emitCompactStarted(rctx);
            rctx.forwardEvent(rctx.buildHeartbeat());
        }
    });

    pi.on("session_compact", () => {
        if (rctx.isCompacting) {
            rctx.isCompacting = false;
            emitCompactEnded(rctx);
            rctx.forwardEvent(rctx.buildHeartbeat());
        }
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
        emitPluginTrustRequired(rctx, rctx.pendingPluginTrust);

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
            const resolvedPromptId = event.promptId as string;
            rctx.pendingPluginTrust = null;
            emitPluginTrustResolved(rctx, resolvedPromptId);
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
            emitMcpStartupReport(rctx, rctx.lastMcpStartupReport);
        }
        // Do NOT call rctx.forwardEvent(report) here. The raw pi event uses a
        // flat shape (no `report` field) so metaEventToPatch produces
        // { mcpStartupReport: undefined }, which JSON.stringify silently drops,
        // wiping the field from Redis. emitMcpStartupReport above already sends
        // the correctly-shaped nested event.
    });
};
