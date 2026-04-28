/**
 * Follow-up grace period and session-complete trigger for child sessions.
 *
 * After a child session's agent_end, the parent has a configurable grace
 * period to send a follow-up message.  If no follow-up arrives the session
 * shuts down automatically.
 *
 * fireSessionComplete emits the session_complete trigger to the parent once
 * and is idempotent thereafter.
 *
 * Extracted from remote/index.ts.
 */

import { createLogger } from "@pizzapi/tools";
import type { RelayContext } from "../remote-types.js";
import { emitSessionCompleteWithAck } from "./session-complete-delivery.js";

const FOLLOWUP_GRACE_MS = 10 * 60 * 1_000;
const SESSION_COMPLETE_RETRY_MS = 3_000;
const log = createLogger("remote");

export interface FollowUpGraceState {
    /** Set to true once session_complete has been emitted — prevents double-fire. */
    sessionCompleteFired: boolean;
    followUpGraceTimer: ReturnType<typeof setTimeout> | null;
    followUpGraceShutdown: (() => void) | null;
    /** Increments on each new turn/session so stale completion promises can be ignored. */
    sessionCompleteGeneration: number;
    /** Increments on relay disconnect so in-flight sends on the old transport are not reused after reconnect. */
    sessionCompleteTransportGeneration: number;
    sessionCompleteRetryTimer: ReturnType<typeof setTimeout> | null;
    pendingSessionCompleteDelivery: Promise<{ ok: boolean; error?: string }> | null;
    pendingSessionCompleteSocket: RelayContext["sioSocket"] | null;
    pendingSessionCompleteTransportGeneration: number | null;
    lastSessionCompletePayload: {
        triggerId: string;
        summary: string;
        fullOutputPath?: string;
        exitReason: "completed" | "killed" | "error";
    } | null;
}

/**
 * Create follow-up grace helpers that share the given mutable state.
 *
 * @param rctx  Relay context (for relay / sioSocket / isChildSession access).
 * @param state Mutable grace-period state.
 */
export function createFollowUpGrace(rctx: RelayContext, state: FollowUpGraceState) {
    function clearFollowUpGrace(): void {
        if (state.followUpGraceTimer !== null) {
            clearTimeout(state.followUpGraceTimer);
            state.followUpGraceTimer = null;
        }
        if (state.sessionCompleteRetryTimer !== null) {
            clearTimeout(state.sessionCompleteRetryTimer);
            state.sessionCompleteRetryTimer = null;
        }
        state.followUpGraceShutdown = null;
    }

    /** If the grace timer is running, fire its shutdown callback immediately. */
    function shutdownFollowUpGraceImmediately(): void {
        if (state.followUpGraceShutdown) {
            const shutdown = state.followUpGraceShutdown;
            clearFollowUpGrace();
            log.info("parent delinked while follow-up grace active — shutting down immediately");
            shutdown();
        }
    }

    /**
     * Start the follow-up grace period.  After FOLLOWUP_GRACE_MS without a
     * follow-up from the parent the session shuts itself down.
     */
    function startFollowUpGrace(ctx: { shutdown: () => void }): void {
        clearFollowUpGrace();
        state.followUpGraceShutdown = ctx.shutdown;
        log.info(`pizzapi: waiting ${FOLLOWUP_GRACE_MS / 1_000}s for parent follow-up before shutting down`);
        state.followUpGraceTimer = setTimeout(() => {
            state.followUpGraceTimer = null;
            state.followUpGraceShutdown = null;
            log.info("pizzapi: follow-up grace period expired — shutting down");
            ctx.shutdown();
        }, FOLLOWUP_GRACE_MS);
        if (
            state.followUpGraceTimer &&
            typeof state.followUpGraceTimer === "object" &&
            "unref" in state.followUpGraceTimer
        ) {
            (state.followUpGraceTimer as NodeJS.Timeout).unref();
        }
    }

    /**
     * Emit a session_complete trigger to the parent session.  Idempotent —
     * subsequent calls after the first successful delivery are silently ignored.
     */
    async function fireSessionComplete(
        summary?: string,
        fullOutputPath?: string,
        exitReason?: "completed" | "killed" | "error",
    ): Promise<{ ok: boolean; error?: string }> {
        if (state.sessionCompleteFired) return { ok: true };

        if (summary !== undefined || fullOutputPath !== undefined || state.lastSessionCompletePayload === null) {
            state.lastSessionCompletePayload = {
                triggerId: state.lastSessionCompletePayload?.triggerId ?? crypto.randomUUID(),
                summary: summary ?? state.lastSessionCompletePayload?.summary ?? "Session completed",
                fullOutputPath: fullOutputPath ?? state.lastSessionCompletePayload?.fullOutputPath,
                exitReason: exitReason ?? state.lastSessionCompletePayload?.exitReason ?? "completed",
            };
        }

        if (!rctx.isChildSession || !rctx.parentSessionId || !rctx.relay || !rctx.sioSocket?.connected) {
            return { ok: false, error: "Child session is not connected to a linked parent" };
        }

        const payload = state.lastSessionCompletePayload ?? {
            summary: "Session completed",
            triggerId: crypto.randomUUID(),
            fullOutputPath: undefined,
            exitReason: exitReason ?? "completed",
        };

        if (
            state.pendingSessionCompleteDelivery &&
            state.pendingSessionCompleteSocket === rctx.sioSocket &&
            state.pendingSessionCompleteTransportGeneration === state.sessionCompleteTransportGeneration
        ) {
            return await state.pendingSessionCompleteDelivery;
        }

        const generation = state.sessionCompleteGeneration;
        const transportGeneration = state.sessionCompleteTransportGeneration;
        const activeSocket = rctx.sioSocket;
        const scheduleRetry = () => {
            if (state.sessionCompleteRetryTimer !== null || state.sessionCompleteFired || !state.lastSessionCompletePayload) return;
            state.sessionCompleteRetryTimer = setTimeout(() => {
                state.sessionCompleteRetryTimer = null;
                void fireSessionComplete();
            }, SESSION_COMPLETE_RETRY_MS);
            if (
                state.sessionCompleteRetryTimer &&
                typeof state.sessionCompleteRetryTimer === "object" &&
                "unref" in state.sessionCompleteRetryTimer
            ) {
                (state.sessionCompleteRetryTimer as NodeJS.Timeout).unref();
            }
        };

        const deliveryPromise = emitSessionCompleteWithAck({
            socket: rctx.sioSocket,
            token: rctx.relay.token,
            sourceSessionId: rctx.relay.sessionId,
            targetSessionId: rctx.parentSessionId,
            triggerId: payload.triggerId,
            summary: payload.summary,
            fullOutputPath: payload.fullOutputPath,
            exitReason: payload.exitReason,
            assumeSuccessOnAckTimeout: !rctx.supportsSessionTriggerAck,
        }).then((result) => {
            if (state.sessionCompleteGeneration !== generation || state.sessionCompleteTransportGeneration !== transportGeneration) {
                return result;
            }
            if (result.ok) {
                state.sessionCompleteFired = true;
                if (state.sessionCompleteRetryTimer !== null) {
                    clearTimeout(state.sessionCompleteRetryTimer);
                    state.sessionCompleteRetryTimer = null;
                }
            } else {
                log.info(`pizzapi: session_complete delivery failed — ${result.error ?? "unknown error"}`);
                scheduleRetry();
            }
            return result;
        }).finally(() => {
            if (
                state.sessionCompleteGeneration === generation &&
                state.sessionCompleteTransportGeneration === transportGeneration &&
                state.pendingSessionCompleteDelivery === deliveryPromise
            ) {
                state.pendingSessionCompleteDelivery = null;
                state.pendingSessionCompleteSocket = null;
                state.pendingSessionCompleteTransportGeneration = null;
            }
        });

        state.pendingSessionCompleteDelivery = deliveryPromise;
        state.pendingSessionCompleteSocket = activeSocket;
        state.pendingSessionCompleteTransportGeneration = transportGeneration;
        return await deliveryPromise;
    }

    return {
        clearFollowUpGrace,
        shutdownFollowUpGraceImmediately,
        startFollowUpGrace,
        fireSessionComplete,
    };
}

export type FollowUpGraceManager = ReturnType<typeof createFollowUpGrace>;
