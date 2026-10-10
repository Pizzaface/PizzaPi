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

/** Default idle period before a completed child's worker exits. */
const DEFAULT_SUSPEND_IDLE_MS = 30 * 60_000;
/** Never suspend faster than this, even with an overridden env value. */
const MIN_SUSPEND_IDLE_MS = 5_000;
const SUSPEND_ACK_TIMEOUT_MS = 5_000;

/**
 * How long a completed child sits idle before its worker exits. Overridable
 * via PIZZAPI_SUSPEND_IDLE_MS (integer ms) for manual testing — the runner
 * forwards it to spawned workers (see session-spawner.ts). An invalid value
 * is ignored; any valid value is clamped to MIN_SUSPEND_IDLE_MS so a typo
 * can't suspend on every idle tick. Read at call time (not cached) so a
 * respawned worker picks up the current env value.
 */
export function getSuspendIdleMs(): number {
    const raw = process.env.PIZZAPI_SUSPEND_IDLE_MS;
    if (!raw) return DEFAULT_SUSPEND_IDLE_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUSPEND_IDLE_MS;
    return Math.max(parsed, MIN_SUSPEND_IDLE_MS);
}

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

/**
 * Abort a suspend the relay already accepted: work arrived on this
 * still-connected socket during the requestSuspend ack round trip (a final
 * local check caught it before the worker exited). The relay has already
 * stopped routing to us — restore it on this same socket instead of
 * spinning up a new worker. Resolves true only on an explicit ok; the caller
 * must not shut down regardless (we never committed to exiting).
 */
export function cancelSuspend(rctx: RelayContext): Promise<boolean> {
    const socket = rctx.sioSocket;
    const relay = rctx.relay;
    if (!socket?.connected || !relay) return Promise.resolve(false);
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), SUSPEND_ACK_TIMEOUT_MS);
        socket.emit(
            "session_suspend_cancel",
            { sessionId: relay.sessionId, token: relay.token },
            (result: { ok: boolean }) => {
                clearTimeout(timeout);
                resolve(result?.ok === true);
            },
        );
    });
}
