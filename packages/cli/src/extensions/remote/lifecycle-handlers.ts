/**
 * Pi event lifecycle handlers.
 *
 * Registers all pi.on() / pi.events.on() listeners for the remote extension.
 * Each listener forwards relevant events to relay viewers and manages
 * sub-module state transitions (session name sync, delink, cancellation,
 * follow-up grace, compaction, etc.).
 *
 * Extracted from remote/index.ts.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
// NOTE: `pi` (the factory argument) is the PiInstance, which has .on()/.registerCommand()/.events
// etc. but is not publicly exported. We type it as `any` in LifecycleHandlersDeps to avoid
// a hard dependency on an internal type. ExtensionContext is used only for ctx parameters
// passed into individual event callbacks.
import { createLogger } from "@pizzapi/tools";
import { stopHeartbeat, buildTokenUsage } from "../remote-heartbeat.js";
import { buildProviderUsage } from "../remote-provider-usage.js";
import { installFooter } from "../remote-footer.js";
import { maybeFireSessionError } from "./session-error-trigger.js";
import {
    emitRetryStateChanged,
    emitPluginTrustRequired,
    emitPluginTrustResolved,
    emitTokenUsageUpdated,
    emitModelChanged,
    emitAuthSourceChanged,
    emitMcpStartupReport,
    emitCompactStarted,
    emitCompactEnded,
    emitTodoUpdated,
    emitPlanModeToggled,
} from "../remote-meta-events.js";
import { getAuthSource } from "../remote-auth-source.js";
import { clearAndCancelPendingTriggers } from "../triggers/extension.js";
import { receivedTriggers } from "../triggers/extension.js";
import { listTriggerSubscriptions, unsubscribeTrigger } from "../trigger-client.js";
import { setTodoUpdateCallback, setTodoMetaEmitter, type TodoItem } from "../update-todo.js";
import { setPlanModeChangeCallback, setPlanModeMetaEmitter } from "../plan-mode/index.js";
import { registerAskUserTool } from "../remote-ask-user.js";
import { registerPlanModeTool } from "../remote-plan-mode.js";
import { isDisabled } from "./connection.js";
import { emitSessionActive } from "./chunked-delivery.js";
import { shouldAutoClose } from "./auto-close.js";
import type { RelayContext } from "../remote-types.js";
import type { TriggerWaitManager } from "../trigger-wait-manager.js";
import type { DelinkManager } from "./delink-management.js";
import type { CancellationManager } from "./trigger-cancellation.js";
import type { FollowUpGraceManager } from "./followup-grace.js";

const log = createLogger("remote");
const LINKED_CHILD_COUNT_TIMEOUT_MS = 2_000;

async function getLinkedChildCount(rctx: RelayContext): Promise<number | null> {
    if (!rctx.relay || !rctx.sioSocket?.connected) return null;

    return await new Promise<number | null>((resolve) => {
        let settled = false;
        const finish = (count: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(count);
        };
        const timeout = setTimeout(() => finish(null), LINKED_CHILD_COUNT_TIMEOUT_MS);
        rctx.sioSocket!.emit(
            "get_linked_child_count",
            { token: rctx.relay!.token },
            (result?: { ok?: boolean; count?: number }) => {
                if (!result?.ok || typeof result.count !== "number") {
                    finish(null);
                    return;
                }
                finish(result.count);
            },
        );
    });
}

/** Shared mutable state fields accessed by the lifecycle handlers. */
export interface LifecycleHandlerState {
    // Delink
    staleChildIds: Set<string>;
    pendingDelink: boolean;
    pendingDelinkEpoch: number | null;
    pendingDelinkOwnParent: boolean;
    stalePrimaryParentId: string | null;
    // Cancellation
    pendingCancellations: Array<{ triggerId: string; childSessionId: string }>;
    // Grace (session_complete fired flag)
    sessionCompleteFired: boolean;
}

export interface LifecycleHandlersDeps {
    /** PiInstance (factory argument) — typed as any since the type is not publicly exported. */
    pi: any;
    rctx: RelayContext;
    state: LifecycleHandlerState;
    triggerWaits: TriggerWaitManager;
    delinkManager: DelinkManager;
    cancellationManager: CancellationManager;
    followUpGrace: FollowUpGraceManager;
    startSessionNameSync: () => void;
    stopSessionNameSync: () => void;
    doConnect: () => void;
    doDisconnect: () => void;
    /** Called during session_shutdown to clear the module-level _ctx pointer. */
    clearCtx: () => void;
}

/**
 * Register all pi event listeners for the remote extension.
 * Returns void — all side effects are via pi.on() / pi.events.on() calls.
 */
export function registerLifecycleHandlers(deps: LifecycleHandlersDeps): void {
    const {
        pi,
        rctx,
        state,
        triggerWaits,
        delinkManager,
        cancellationManager,
        followUpGrace,
        startSessionNameSync,
        stopSessionNameSync,
        doConnect,
        doDisconnect,
        clearCtx,
    } = deps;

    // Session-local error-fired flag (not shared — only used inside agent_end/turn_start).
    let sessionErrorFired = false;

    // ── Register tools ────────────────────────────────────────────────────────
    registerAskUserTool(rctx);
    registerPlanModeTool(rctx);

    // ── Wire up todo / plan-mode callbacks ────────────────────────────────────

    setTodoUpdateCallback((list: TodoItem[]) => {
        rctx.forwardEvent({ type: "todo_update", todos: list, ts: Date.now() });
    });
    setTodoMetaEmitter((list) => emitTodoUpdated(rctx, list as any));

    setPlanModeChangeCallback((_enabled: boolean) => {
        rctx.forwardEvent(rctx.buildHeartbeat());
    });
    setPlanModeMetaEmitter((enabled) => emitPlanModeToggled(rctx, enabled));

    // ── Session lifecycle ─────────────────────────────────────────────────────

    pi.on("session_start", (_event: any, ctx: any) => {
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
                "\x1b[33m⚠ Relay not configured\x1b[39m\x1b[2m — sessions won't appear in the web UI.\x1b[22m\n" +
                "Run \x1b[95m`pizza setup`\x1b[39m or set \x1b[95mPIZZAPI_API_KEY\x1b[39m to connect.",
            );
        }
    });

    pi.on("session_switch", (event: any, ctx: any) => {
        rctx.latestCtx = ctx;
        rctx.sessionStartedAt = Date.now();
        rctx.isAgentActive = false;

        // ── /new cleanup: cancel pending triggers and delink children ─────────
        if (event.reason === "new") {
            state.staleChildIds.clear();
            for (const entry of receivedTriggers.values()) {
                state.staleChildIds.add(entry.sourceSessionId);
            }
            for (const { childSessionId } of state.pendingCancellations) {
                state.staleChildIds.add(childSessionId);
            }

            const { cancelled, sent, failed } = clearAndCancelPendingTriggers(
                (confirmedTriggerId, confirmedChildSessionId) => {
                    const idx = state.pendingCancellations.findIndex(
                        (c) =>
                            c.triggerId === confirmedTriggerId &&
                            c.childSessionId === confirmedChildSessionId,
                    );
                    if (idx >= 0) {
                        state.pendingCancellations.splice(idx, 1);
                        log.info(
                            `pizzapi: trigger cancellation confirmed for ${confirmedTriggerId} — removed from retry queue`,
                        );
                        if (state.pendingCancellations.length === 0) {
                            cancellationManager.stopPendingCancellationRetryLoop();
                        }
                    }
                },
            );

            if (cancelled > 0) {
                log.info(
                    `pizzapi: cancelled ${cancelled} pending trigger(s) on session switch (${sent.length} sent-pending-ack, ${failed.length} deferred)`,
                );
            }

            const allNeedingConfirmation = [...sent, ...failed];
            if (allNeedingConfirmation.length > 0) {
                state.pendingCancellations = [...state.pendingCancellations, ...allNeedingConfirmation];
                for (const { childSessionId } of allNeedingConfirmation) {
                    state.staleChildIds.add(childSessionId);
                }
                if (rctx.relay && rctx.sioSocket?.connected) {
                    cancellationManager.startPendingCancellationRetryLoop();
                }
            }

            // ── Unsubscribe from all active trigger subscriptions ─────────────
            const sid = rctx.relaySessionId;
            if (sid) {
                listTriggerSubscriptions(sid)
                    .then(async (subs) => {
                        if (subs.length === 0) return;
                        log.info(`pizzapi: unsubscribing from ${subs.length} trigger subscription(s) on /new`);
                        const results = await Promise.allSettled(
                            subs.map((s) => unsubscribeTrigger(sid, { subscriptionId: s.subscriptionId, triggerType: s.triggerType })),
                        );
                        const failedSubs = results.filter(
                            (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok),
                        );
                        if (failedSubs.length > 0) {
                            log.info(`pizzapi: ${failedSubs.length} trigger unsubscribe(s) failed on /new`);
                        }
                    })
                    .catch((err) => {
                        log.info(
                            `pizzapi: trigger subscription cleanup failed on /new: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    });
            }

            const rawDelinkEpoch = Date.now();
            state.pendingDelink = true;
            state.pendingDelinkEpoch = rawDelinkEpoch;
            delinkManager.clearPendingDelinkRetryTimer();
            if (rctx.relay && rctx.sioSocket?.connected) {
                delinkManager.emitDelinkChildren(rawDelinkEpoch);
            }

            if (rctx.isChildSession) {
                const cancelledChild = triggerWaits.cancelAll("Session switched — parent link cleared.");
                log.info(
                    `pizzapi: clearing own parent link on /new${cancelledChild > 0 ? ` — cancelled ${cancelledChild} pending trigger wait(s)` : ""}`,
                );
                state.pendingDelinkOwnParent = true;
                delinkManager.clearPendingDelinkOwnParentRetryTimer();
                state.stalePrimaryParentId = rctx.parentSessionId;
                if (rctx.relay && rctx.sioSocket?.connected) {
                    delinkManager.emitDelinkOwnParent();
                }
                rctx.parentSessionId = null;
                rctx.isChildSession = false;
                followUpGrace.clearFollowUpGrace();
            }
        }

        state.sessionCompleteFired = false;

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
        // Emit model_changed so the UI gets contextWindow immediately.
        if (rctx.latestCtx?.model) {
            const m = rctx.latestCtx.model;
            emitModelChanged(rctx, {
                provider: m.provider,
                id: m.id,
                name: m.name,
                reasoning: m.reasoning,
                contextWindow: m.contextWindow,
            });
        }
    });

    pi.on("turn_start", (event: any) => {
        state.sessionCompleteFired = false;
        sessionErrorFired = false;
        rctx.wasAborted = false;
        followUpGrace.clearFollowUpGrace();
        rctx.forwardEvent(event);
    });

    pi.on("session_shutdown", () => {
        rctx.shuttingDown = true;
        followUpGrace.clearFollowUpGrace();
        stopHeartbeat();
        stopSessionNameSync();
        clearCtx();
        const shutdownExitReason = rctx.wasAborted ? "killed" : rctx.lastRetryableError ? "error" : "completed";
        followUpGrace.fireSessionComplete(undefined, undefined, shutdownExitReason);
        doDisconnect();
    });

    // ── Agent lifecycle ───────────────────────────────────────────────────────

    pi.on("agent_start", (event: any) => {
        rctx.isAgentActive = true;
        rctx.lastRetryableError = null;
        emitRetryStateChanged(rctx, null);
        rctx.forwardEvent(event);
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    pi.on("agent_end", (event: any, ctx: any) => {
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
                                    const tmpPath = join(
                                        tmpdir(),
                                        `pizzapi-session-${sessionSlug}-${uniqueSuffix}-output.md`,
                                    );
                                    writeFileSync(tmpPath, full, "utf-8");
                                    fullOutputPath = tmpPath;
                                } catch {
                                    /* best-effort */
                                }
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
            followUpGrace.fireSessionComplete(summary, fullOutputPath, exitReason);

            // Fire session_error for terminal usage-limit errors (one-shot, only at agent_end).
            if (
                maybeFireSessionError({
                    sessionErrorFired,
                    errorMessage: lastError?.errorMessage,
                    isChildSession: rctx.isChildSession,
                    parentSessionId: rctx.parentSessionId,
                    socketConnected: rctx.sioSocket?.connected ?? false,
                    emitFn: rctx.sioSocket
                        ? (ev: string, payload: any) => (rctx.sioSocket as any).emit(ev, payload)
                        : null,
                    relayToken: rctx.relay?.token,
                    relaySessionId: rctx.relay?.sessionId,
                })
            ) {
                sessionErrorFired = true;
            }

            if (rctx.isChildSession) {
                followUpGrace.startFollowUpGrace(ctx);
            } else if (process.env.PIZZAPI_WORKER_AUTO_CLOSE === "true" && exitReason === "completed") {
                // Auto-close: trigger-spawned sessions with autoClose shut down
                // immediately on successful completion — no follow-up grace.
                // But skip if the session still has active trigger subscriptions
                // or linked child sessions that may session_complete later.
                void (async () => {
                    const sessionId = rctx.relaySessionId;
                    const activeSubscriptionCount = sessionId
                        ? await listTriggerSubscriptions(sessionId)
                            .then((subs) => subs.length)
                            .catch(() => null)
                        : null;
                    if (typeof activeSubscriptionCount === "number" && activeSubscriptionCount > 0) {
                        log.info(`pizzapi: auto-close skipped — session has ${activeSubscriptionCount} active trigger subscription(s)`);
                        return;
                    }

                    const linkedChildCount = await getLinkedChildCount(rctx);
                    if (typeof linkedChildCount === "number" && linkedChildCount > 0) {
                        log.info(`pizzapi: auto-close skipped — session has ${linkedChildCount} linked child session(s)`);
                        return;
                    }

                    if (!shouldAutoClose({
                        autoCloseEnv: process.env.PIZZAPI_WORKER_AUTO_CLOSE,
                        exitReason,
                        isChildSession: rctx.isChildSession,
                        hasPendingMessages: false,
                        activeSubscriptionCount,
                        linkedChildCount,
                    })) {
                        log.info("pizzapi: auto-close skipped — unable to prove session is fully idle");
                        return;
                    }

                    log.info("pizzapi: auto-close enabled and session completed successfully — shutting down");
                    ctx.shutdown();
                })();
            }
        }
    });

    pi.on("turn_end", (event: any) => {
        rctx.forwardEvent(event);
        const tokenUsage = buildTokenUsage(rctx);
        const providerUsage = buildProviderUsage();
        emitTokenUsageUpdated(rctx, tokenUsage as any, providerUsage as any);
    });

    pi.on("message_start", (event: any) => rctx.forwardEvent(event));
    pi.on("message_update", (event: any) => rctx.forwardEvent(event));

    pi.on("message_end", (event: any) => {
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
                // Agent recovered — clear the latch so we don't report a false-positive error exit.
                rctx.lastRetryableError = null;
                emitRetryStateChanged(rctx, null);
            }
        }
    });

    pi.on("tool_execution_start", (event: any) => rctx.forwardEvent(event));
    pi.on("tool_execution_update", (event: any) => rctx.forwardEvent(event));
    pi.on("tool_execution_end", (event: any) => rctx.forwardEvent(event));

    pi.on("model_select", (event: any) => {
        rctx.forwardEvent(event);
        emitAuthSourceChanged(rctx, getAuthSource(rctx.latestCtx));
        emitSessionActive(rctx);
    });

    // ── Compaction ────────────────────────────────────────────────────────────

    pi.on("session_before_compact", () => {
        // Only emit if not already tracked (web-triggered compacts set the flag
        // in the exec handler before calling ctx.compact()).
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
        }
        // Always refresh after compaction so the UI sees the post-compact context size.
        rctx.emitSessionActive();
        const tokenUsage = buildTokenUsage(rctx);
        const providerUsage = buildProviderUsage();
        emitTokenUsageUpdated(rctx, tokenUsage as any, providerUsage as any);
        rctx.forwardEvent(rctx.buildHeartbeat());
    });

    // ── /remote command ───────────────────────────────────────────────────────

    pi.registerCommand("remote", {
        description: "Show relay share URL, or: /remote stop | /remote reconnect",
        getArgumentCompletions: (prefix: string) => {
            const options = ["stop", "reconnect"];
            const filtered = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
            return filtered.length ? filtered.map((o) => ({ value: o, label: o })) : null;
        },
        handler: async (args: string, ctx: any) => {
            const arg = args.trim().toLowerCase();
            if (arg === "stop") {
                doDisconnect();
                ctx.ui.notify("\x1b[31m✕ Disconnected from relay.\x1b[39m");
                return;
            }
            if (arg === "reconnect") {
                doDisconnect();
                rctx.shuttingDown = false;
                doConnect();
                ctx.ui.notify("\x1b[33m↻ Reconnecting to relay…\x1b[39m");
                return;
            }
            if (rctx.relay) {
                ctx.ui.notify(
                    `\x1b[32m✓ Connected to Relay\x1b[39m\n` +
                    `\x1b[2mShare URL:\x1b[22m \x1b[95m${rctx.relay.shareUrl}\x1b[39m`,
                );
            } else {
                const url = isDisabled()
                    ? "(disabled — set PIZZAPI_RELAY_URL to enable)"
                    : rctx.relayUrl();
                ctx.ui.notify(
                    `\x1b[31m✕ Not connected to relay.\x1b[39m\n` +
                    `\x1b[2mRelay:\x1b[22m ${url}\n` +
                    `\x1b[2mUse\x1b[22m \x1b[95m/remote reconnect\x1b[39m \x1b[2mto retry.\x1b[22m`,
                );
            }
        },
    });

    // ── Plugin trust bridge ───────────────────────────────────────────────────

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

    // ── MCP events ────────────────────────────────────────────────────────────

    pi.events.on("mcp:auth_required", (data: unknown) => rctx.forwardEvent(data));
    pi.events.on("mcp:auth_paste_required", (data: unknown) => rctx.forwardEvent(data));
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
                errors: Array.isArray(r.errors) ? (r.errors as any) : [],
                serverTimings: Array.isArray(r.serverTimings) ? (r.serverTimings as any) : [],
                ts: typeof r.ts === "number" ? r.ts : Date.now(),
            };
            emitMcpStartupReport(rctx, rctx.lastMcpStartupReport);
        }
        // Do NOT call rctx.forwardEvent(report) here — the raw pi event uses a
        // flat shape (no `report` field) so metaEventToPatch produces
        // { mcpStartupReport: undefined }, wiping the field from Redis.
        // emitMcpStartupReport above already sends the correctly-shaped event.
    });
}
