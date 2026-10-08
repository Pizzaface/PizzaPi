/**
 * Suspend for idle completed child sessions.
 *
 * A finished child used to wait forever for its parent's ack while its worker
 * kept 150–700 MB resident. Suspend exits the worker but keeps the session on
 * the relay: the record, parent link, routes and pending deliveries stay, and
 * the next message (send_message, trigger, user input) makes the runner
 * respawn the worker on the same transcript.
 */

import type { RelayContext } from "../remote-types.js";

/** How long a completed child sits idle before its worker exits. */
export const SUSPEND_IDLE_MS = 30 * 60_000;
const SUSPEND_ACK_TIMEOUT_MS = 5_000;

export interface SuspendProbe {
    /** session_complete reached the parent (only then is it safe to exit). */
    sessionCompleteDelivered: boolean;
    hasPendingMessages: boolean;
    isAgentBusy: boolean;
    activeSubagents: boolean;
    runningBackgroundJobs: number;
    /** null = probe failed; unknown is never treated as idle. */
    activeSubscriptionCount: number | null;
    linkedChildCount: number | null;
}

/** Everything that would die with the worker must be absent. */
export function shouldSuspend(p: SuspendProbe): boolean {
    return p.sessionCompleteDelivered
        && !p.hasPendingMessages
        && !p.isAgentBusy
        && !p.activeSubagents
        && p.runningBackgroundJobs === 0
        && p.activeSubscriptionCount === 0
        && p.linkedChildCount === 0;
}

/** Only runner-spawned workers can be woken again (same marker as /restart). */
export function canSuspendWorker(): boolean {
    return !!process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
}

/**
 * Ask the relay to mark this session suspended. Resolves true only on an
 * explicit ok — an older relay without the handler never acks, and the
 * worker simply stays alive as before.
 */
export function requestSuspend(rctx: RelayContext): Promise<boolean> {
    const socket = rctx.sioSocket;
    const relay = rctx.relay;
    if (!socket?.connected || !relay) return Promise.resolve(false);
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), SUSPEND_ACK_TIMEOUT_MS);
        socket.emit(
            "session_suspend",
            { sessionId: relay.sessionId, token: relay.token },
            (result: { ok: boolean }) => {
                clearTimeout(timeout);
                resolve(result?.ok === true);
            },
        );
    });
}
