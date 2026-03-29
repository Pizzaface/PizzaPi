/**
 * Child-session delink management.
 *
 * Handles emitting `delink_children` / `delink_own_parent` to the relay
 * when a session runs /new, with automatic retry if the emit fails or the
 * relay is temporarily unreachable.
 *
 * Extracted from remote/index.ts.
 */

import { createLogger } from "@pizzapi/tools";
import type { RelayContext } from "../remote-types.js";
import { evaluateDelinkChildrenAck, evaluateDelinkOwnParentAck } from "../remote-delink-retry.js";

export const DELINK_RETRY_DELAY_MS = 3_000;

const log = createLogger("remote");

export interface DelinkState {
    pendingDelink: boolean;
    pendingDelinkRetryTimer: ReturnType<typeof setTimeout> | null;
    pendingDelinkRetryEpoch: number | null;
    pendingDelinkEpoch: number | null;
    staleChildIds: Set<string>;
    pendingDelinkOwnParent: boolean;
    pendingDelinkOwnParentRetryTimer: ReturnType<typeof setTimeout> | null;
    stalePrimaryParentId: string | null;
    serverClockOffset: number;
}

/**
 * Create delink-management helpers that share the given mutable state.
 *
 * @param rctx  Relay context (for relay / sioSocket access).
 * @param state Mutable delink state.
 */
export function createDelinkManager(rctx: RelayContext, state: DelinkState) {
    // ── delink_children ───────────────────────────────────────────────────────

    function clearPendingDelinkRetryTimer(epoch?: number | null): void {
        if (state.pendingDelinkRetryTimer === null) return;
        if (epoch !== undefined && epoch !== null && state.pendingDelinkRetryEpoch !== epoch) return;
        clearTimeout(state.pendingDelinkRetryTimer);
        state.pendingDelinkRetryTimer = null;
        state.pendingDelinkRetryEpoch = null;
    }

    function emitDelinkChildren(rawEpoch: number): void {
        if (!rctx.relay || !rctx.sioSocket?.connected) return;
        rctx.sioSocket.emit(
            "delink_children",
            { token: rctx.relay.token, epoch: rawEpoch + state.serverClockOffset },
            (result: { ok: boolean; error?: string }) => {
                const plan = evaluateDelinkChildrenAck({
                    ackEpoch: rawEpoch,
                    pendingEpoch: state.pendingDelinkEpoch,
                    retryEpoch: state.pendingDelinkRetryEpoch,
                    ok: result?.ok,
                    connected: Boolean(rctx.sioSocket?.connected),
                });

                if (plan.ignoreAck) {
                    log.info("pizzapi: ignoring stale delink_children ack (superseded by a later /new)");
                    if (plan.clearRetryTimer) clearPendingDelinkRetryTimer(rawEpoch);
                    return;
                }

                if (plan.scheduleRetry) {
                    log.info(
                        `pizzapi: delink_children server error: ${result?.error ?? "unknown"} — scheduling retry in ${DELINK_RETRY_DELAY_MS}ms`,
                    );
                    if (plan.clearRetryTimer) clearPendingDelinkRetryTimer(rawEpoch);
                    state.pendingDelinkRetryEpoch = rawEpoch;
                    state.pendingDelinkRetryTimer = setTimeout(() => {
                        state.pendingDelinkRetryTimer = null;
                        state.pendingDelinkRetryEpoch = null;
                        if (state.pendingDelinkEpoch === rawEpoch && rctx.sioSocket?.connected) {
                            log.info("pizzapi: retrying delink_children after server error");
                            emitDelinkChildren(rawEpoch);
                        }
                    }, DELINK_RETRY_DELAY_MS);
                    return;
                }

                if (plan.clearRetryTimer) clearPendingDelinkRetryTimer(rawEpoch);
                if (!plan.clearPendingDelink) return;
                state.pendingDelink = false;
                state.pendingDelinkEpoch = null;
                state.staleChildIds.clear();
            },
        );
    }

    // ── delink_own_parent ─────────────────────────────────────────────────────

    function clearPendingDelinkOwnParentRetryTimer(): void {
        if (state.pendingDelinkOwnParentRetryTimer === null) return;
        clearTimeout(state.pendingDelinkOwnParentRetryTimer);
        state.pendingDelinkOwnParentRetryTimer = null;
    }

    function emitDelinkOwnParent(): void {
        if (!state.pendingDelinkOwnParent || !rctx.relay || !rctx.sioSocket?.connected) return;
        rctx.sioSocket.emit(
            "delink_own_parent",
            { token: rctx.relay.token, oldParentId: state.stalePrimaryParentId },
            (result: { ok: boolean; error?: string }) => {
                const plan = evaluateDelinkOwnParentAck({
                    ok: result?.ok,
                    pending: state.pendingDelinkOwnParent,
                    connected: Boolean(rctx.sioSocket?.connected),
                });

                if (plan.confirmed) {
                    clearPendingDelinkOwnParentRetryTimer();
                    state.pendingDelinkOwnParent = false;
                    state.stalePrimaryParentId = null;
                    log.info("pizzapi: delink_own_parent confirmed by server");
                    return;
                }

                if (!plan.scheduleRetry) return;
                log.info(
                    `pizzapi: delink_own_parent server error: ${result?.error ?? "unknown"} — scheduling retry in ${DELINK_RETRY_DELAY_MS}ms`,
                );
                clearPendingDelinkOwnParentRetryTimer();
                state.pendingDelinkOwnParentRetryTimer = setTimeout(() => {
                    state.pendingDelinkOwnParentRetryTimer = null;
                    if (state.pendingDelinkOwnParent && rctx.sioSocket?.connected) {
                        log.info("pizzapi: retrying delink_own_parent after server error");
                        emitDelinkOwnParent();
                    }
                }, DELINK_RETRY_DELAY_MS);
            },
        );
    }

    return {
        clearPendingDelinkRetryTimer,
        emitDelinkChildren,
        clearPendingDelinkOwnParentRetryTimer,
        emitDelinkOwnParent,
    };
}

export type DelinkManager = ReturnType<typeof createDelinkManager>;
