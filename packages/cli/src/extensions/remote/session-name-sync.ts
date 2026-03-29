/**
 * Session name synchronization.
 *
 * Polls for session name changes every second and re-emits session_active
 * to keep relay viewers in sync when the agent names the session.
 *
 * Extracted from remote/index.ts.
 */

import type { RelayContext } from "../remote-types.js";
import { emitSessionActive } from "./chunked-delivery.js";

export interface SessionNameSyncState {
    sessionNameSyncTimer: ReturnType<typeof setInterval> | null;
    /** Most-recently broadcast session name — used to detect changes. */
    lastBroadcastSessionName: string | null;
}

/**
 * Create session-name sync helpers that share the given mutable state.
 *
 * @param rctx  Relay context (for getCurrentSessionName / forwardEvent / buildHeartbeat).
 * @param state Mutable state object — shared with rctx.markSessionNameBroadcasted.
 */
export function createSessionNameSync(rctx: RelayContext, state: SessionNameSyncState) {
    function stopSessionNameSync(): void {
        if (state.sessionNameSyncTimer !== null) {
            clearInterval(state.sessionNameSyncTimer);
            state.sessionNameSyncTimer = null;
        }
    }

    function startSessionNameSync(): void {
        stopSessionNameSync();
        // Snapshot the current name so the first tick only fires on a real change.
        state.lastBroadcastSessionName = rctx.getCurrentSessionName();

        state.sessionNameSyncTimer = setInterval(() => {
            const currentSessionName = rctx.getCurrentSessionName();
            if (currentSessionName === state.lastBroadcastSessionName) return;

            state.lastBroadcastSessionName = currentSessionName;
            emitSessionActive(rctx);
            rctx.forwardEvent(rctx.buildHeartbeat());
        }, 1_000);
    }

    return { startSessionNameSync, stopSessionNameSync };
}
