/**
 * ConnectionHandlers factory — doConnect / doDisconnect wrappers.
 *
 * Builds the `ConnectionHandlers` object (required by connection.ts's
 * `connect` / `disconnect` functions) from the sub-module helpers and the
 * shared mutable state, then returns thin `doConnect` / `doDisconnect`
 * wrappers that bind rctx and the handlers together.
 *
 * Extracted from remote/index.ts.
 */

import { createLogger } from "@pizzapi/tools";
import type { RelayContext } from "../remote-types.js";
import type { TriggerWaitManager } from "../trigger-wait-manager.js";
import { connect, disconnect, type ConnectionHandlers } from "./connection.js";
import type { DelinkManager } from "./delink-management.js";
import type { CancellationManager } from "./trigger-cancellation.js";
import type { FollowUpGraceManager } from "./followup-grace.js";

const log = createLogger("remote");

/** Subset of the shared factory state needed by ConnectionHandlers. */
export interface ConnectionHandlerState {
    pendingDelinkOwnParent: boolean;
    serverClockOffset: number;
    staleChildIds: Set<string>;
    stalePrimaryParentId: string | null;
    pendingDelink: boolean;
    pendingDelinkEpoch: number | null;
    pendingCancellations: Array<{ triggerId: string; childSessionId: string }>;
}

export interface ConnectionHandlersDeps {
    pi: any;
    rctx: RelayContext;
    state: ConnectionHandlerState;
    triggerWaits: TriggerWaitManager;
    delinkManager: DelinkManager;
    cancellationManager: CancellationManager;
    followUpGrace: FollowUpGraceManager;
    setModelFromWeb: (provider: string, modelId: string) => Promise<void>;
}

/**
 * Build ConnectionHandlers + doConnect/doDisconnect from the provided deps.
 */
export function createConnectionHandlers(deps: ConnectionHandlersDeps) {
    const { pi, rctx, state, triggerWaits, delinkManager, cancellationManager, followUpGrace, setModelFromWeb } = deps;

    const connectionHandlers: ConnectionHandlers = {
        clearFollowUpGrace: followUpGrace.clearFollowUpGrace,

        setModelFromWeb,

        sendUserMessage: (msg: unknown, opts?: { deliverAs?: "followUp" | "steer" }) =>
            (pi as any).sendUserMessage(msg, opts),

        // ── Delink handlers ───────────────────────────────────────────────

        isPendingDelinkOwnParent: () => state.pendingDelinkOwnParent,

        setServerClockOffset: (offset: number) => {
            state.serverClockOffset = offset;
        },

        isStaleChild: (sessionId: string) => state.staleChildIds.has(sessionId),

        getStalePrimaryParentId: () => state.stalePrimaryParentId,

        onParentExplicitlyDelinked: () => {
            const cancelledWaits = triggerWaits.cancelAll(
                "Parent started a new session — trigger cancelled.",
            );
            if (cancelledWaits > 0) {
                log.info(
                    `pizzapi: parent explicitly delinked (wasDelinked) — cancelled ${cancelledWaits} pending trigger wait(s)`,
                );
            }
            followUpGrace.shutdownFollowUpGraceImmediately();
            log.info("pizzapi: parent explicitly delinked — clearing parent link permanently");
            rctx.parentSessionId = null;
            rctx.isChildSession = false;
        },

        onParentTransientlyOffline: () => {
            log.info(
                `pizzapi: parent temporarily offline (${rctx.parentSessionId}) — preserving parent link and child mode for reconnect`,
            );
        },

        onParentDelinked: (ack?: (result: { ok: boolean }) => void) => {
            if (rctx.isChildSession) {
                const cancelled = triggerWaits.cancelAll(
                    "Parent started a new session — trigger cancelled.",
                );
                log.info(
                    `pizzapi: parent delinked — this session is no longer a child${cancelled > 0 ? ` — cancelled ${cancelled} pending trigger wait(s)` : ""}`,
                );
                rctx.parentSessionId = null;
                rctx.isChildSession = false;
                followUpGrace.shutdownFollowUpGraceImmediately();
            }
            ack?.({ ok: true });
        },

        flushDeferredDelinks: () => {
            if (state.pendingDelink && state.pendingDelinkEpoch !== null && rctx.sioSocket?.connected) {
                delinkManager.emitDelinkChildren(state.pendingDelinkEpoch);
                log.info("pizzapi: flushed deferred delink_children after reconnect");
            }
            if (state.pendingDelinkOwnParent && rctx.sioSocket?.connected) {
                delinkManager.emitDelinkOwnParent();
                log.info("pizzapi: flushed deferred delink_own_parent after reconnect");
            }
            if (state.pendingCancellations.length > 0 && rctx.sioSocket?.connected) {
                cancellationManager.startPendingCancellationRetryLoop();
                cancellationManager.retryPendingTriggerCancellations("registered");
            }
        },

        onDelinkDisconnect: () => {
            cancellationManager.stopPendingCancellationRetryLoop();
            delinkManager.clearPendingDelinkRetryTimer();
            delinkManager.clearPendingDelinkOwnParentRetryTimer();
        },

        onSocketTeardown: () => {
            cancellationManager.stopPendingCancellationRetryLoop();
        },

        getParentSessionIdForRegister: () => {
            return rctx.parentSessionId ?? (state.pendingDelinkOwnParent ? null : undefined);
        },
    };

    function doConnect(): void {
        connect(rctx, connectionHandlers);
    }

    function doDisconnect(): void {
        disconnect(rctx, connectionHandlers);
    }

    return { connectionHandlers, doConnect, doDisconnect };
}
