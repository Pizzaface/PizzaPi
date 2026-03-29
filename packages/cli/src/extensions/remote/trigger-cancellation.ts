/**
 * Pending trigger cancellation retry loop.
 *
 * When a /new session switch occurs while child triggers are in-flight,
 * we need to emit trigger_response("cancel") for each pending trigger.
 * If the relay is temporarily unreachable the cancellation is queued and
 * retried periodically until it is acknowledged.
 *
 * Extracted from remote/index.ts.
 */

import { createLogger } from "@pizzapi/tools";
import type { RelayContext } from "../remote-types.js";

const TRIGGER_CANCELLATION_RETRY_INTERVAL_MS = 3_000;
const log = createLogger("remote");

export interface CancellationState {
    pendingCancellations: Array<{ triggerId: string; childSessionId: string }>;
    pendingCancellationRetryTimer: ReturnType<typeof setInterval> | null;
    pendingCancellationRetryInFlight: boolean;
}

/**
 * Create cancellation-retry helpers that share the given mutable state.
 *
 * @param rctx  Relay context (for relay / sioSocket access).
 * @param state Mutable cancellation state.
 */
export function createCancellationManager(rctx: RelayContext, state: CancellationState) {
    function stopPendingCancellationRetryLoop(): void {
        if (state.pendingCancellationRetryTimer !== null) {
            clearInterval(state.pendingCancellationRetryTimer);
            state.pendingCancellationRetryTimer = null;
        }
        state.pendingCancellationRetryInFlight = false;
    }

    function startPendingCancellationRetryLoop(): void {
        if (state.pendingCancellationRetryTimer !== null) return;
        state.pendingCancellationRetryTimer = setInterval(() => {
            void retryPendingTriggerCancellations("periodic");
        }, TRIGGER_CANCELLATION_RETRY_INTERVAL_MS);
    }

    function retryPendingTriggerCancellations(reason: string): void {
        if (state.pendingCancellations.length === 0) {
            stopPendingCancellationRetryLoop();
            return;
        }
        if (!rctx.relay || !rctx.sioSocket?.connected) return;
        if (state.pendingCancellationRetryInFlight) return;

        state.pendingCancellationRetryInFlight = true;
        const token = rctx.relay.token;
        const cancellationsToRetry = [...state.pendingCancellations];
        let successfulCancellations = 0;
        let failedCancellations = 0;
        let completedResponses = 0;
        let finished = false;

        const finishBatch = () => {
            if (finished) return;
            finished = true;
            state.pendingCancellationRetryInFlight = false;
            if (state.pendingCancellations.length === 0) {
                stopPendingCancellationRetryLoop();
            }
        };

        const timeout = setTimeout(() => {
            if (finished) return;
            const missing = cancellationsToRetry.length - completedResponses;
            failedCancellations += missing;
            log.info(
                `pizzapi: trigger cancellation retry timed out (${missing} ack callback(s) missing) — will retry`,
            );
            finishBatch();
        }, 10_000);

        log.info(
            `pizzapi: retrying ${cancellationsToRetry.length} deferred trigger cancellation(s) (${reason})`,
        );

        for (const { triggerId, childSessionId } of cancellationsToRetry) {
            rctx.sioSocket!.emit("trigger_response" as any, {
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
                    const index = state.pendingCancellations.findIndex(
                        (c) => c.triggerId === triggerId && c.childSessionId === childSessionId,
                    );
                    if (index >= 0) {
                        state.pendingCancellations.splice(index, 1);
                    }
                } else {
                    failedCancellations++;
                    log.info(
                        `pizzapi: trigger cancellation failed for ${triggerId}: ${result?.error ?? "unknown"} — will retry`,
                    );
                }

                if (completedResponses === cancellationsToRetry.length) {
                    clearTimeout(timeout);
                    log.info(
                        `pizzapi: trigger cancellation retry complete: ${successfulCancellations} succeeded, ${failedCancellations} failed`,
                    );
                    finishBatch();
                }
            });
        }
    }

    return {
        stopPendingCancellationRetryLoop,
        startPendingCancellationRetryLoop,
        retryPendingTriggerCancellations,
    };
}

export type CancellationManager = ReturnType<typeof createCancellationManager>;
