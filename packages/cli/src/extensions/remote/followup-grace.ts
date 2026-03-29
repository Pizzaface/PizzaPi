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

const FOLLOWUP_GRACE_MS = 10 * 60 * 1_000;
const log = createLogger("remote");

export interface FollowUpGraceState {
    /** Set to true once session_complete has been emitted — prevents double-fire. */
    sessionCompleteFired: boolean;
    followUpGraceTimer: ReturnType<typeof setTimeout> | null;
    followUpGraceShutdown: (() => void) | null;
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
     * subsequent calls after the first are silently ignored.
     */
    function fireSessionComplete(
        summary?: string,
        fullOutputPath?: string,
        exitReason?: "completed" | "killed" | "error",
    ): void {
        if (state.sessionCompleteFired) return;
        if (!rctx.isChildSession || !rctx.parentSessionId || !rctx.relay || !rctx.sioSocket?.connected) return;
        state.sessionCompleteFired = true;
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

    return {
        clearFollowUpGrace,
        shutdownFollowUpGraceImmediately,
        startFollowUpGrace,
        fireSessionComplete,
    };
}

export type FollowUpGraceManager = ReturnType<typeof createFollowUpGrace>;
