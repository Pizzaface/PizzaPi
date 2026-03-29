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
/** Max attempts before dropping a cancellation as permanently failed. */
const MAX_CANCELLATION_RETRIES = 10;
/**
 * Error messages that indicate the cancellation will never succeed,
 * regardless of how many times we retry (e.g. the target session no
 * longer exists under this user, or the parent relationship is broken).
 */
const PERMANENT_ERRORS = [
    "Target session belongs to a different user",
    "Sender is not the parent of the target session",
];
const log = createLogger("remote");

export interface CancellationState {
    pendingCancellations: Array<{ triggerId: string; childSessionId: string; retryCount?: number }>;
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
                    const errorMsg = result?.error ?? "unknown";
                    const isPermanent = PERMANENT_ERRORS.some((pe) => errorMsg.includes(pe));
                    const entry = state.pendingCancellations.find(
                        (c) => c.triggerId === triggerId && c.childSessionId === childSessionId,
                    );
                    if (entry) {
                        entry.retryCount = (entry.retryCount ?? 0) + 1;
                    }
                    const retries = entry?.retryCount ?? 1;

                    if (isPermanent || retries >= MAX_CANCELLATION_RETRIES) {
                        // Permanent error or exceeded max retries — drop it
                        const reason = isPermanent ? "permanent error" : `exceeded ${MAX_CANCELLATION_RETRIES} retries`;
                        log.info(
                            `pizzapi: trigger cancellation for ${triggerId} dropped (${reason}: ${errorMsg})`,
                        );
                        const index = state.pendingCancellations.findIndex(
                            (c) => c.triggerId === triggerId && c.childSessionId === childSessionId,
                        );
                        if (index >= 0) {
                            state.pendingCancellations.splice(index, 1);
                        }
                        successfulCancellations++; // Count as resolved for batch logging
                    } else {
                        failedCancellations++;
                        log.info(
                            `pizzapi: trigger cancellation failed for ${triggerId}: ${errorMsg} — will retry (${retries}/${MAX_CANCELLATION_RETRIES})`,
                        );
                    }
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
