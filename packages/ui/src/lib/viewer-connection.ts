export function resetStaleBaselineOnVisibilityChange(
    visibilityState: DocumentVisibilityState,
    lastEventAt: number,
    now: number,
): number {
    return visibilityState === "visible" ? now : lastEventAt;
}

/**
 * Whether the stale-connection watchdog should check elapsed-since-last-event
 * this tick. Only depends on having an active session and a socket that
 * believes it's connected — NOT on whether the agent is active.
 *
 * Heartbeats are forwarded on a fixed ~10s interval regardless of agent
 * activity (see packages/cli/src/extensions/remote-heartbeat.ts), so a
 * healthy idle connection keeps refreshing the last-event timestamp on its
 * own. Gating this on agent activity doesn't protect legitimate idle silence
 * (there isn't any) — it just hides a genuinely dead socket on an idle
 * session until the user happens to send a message.
 */
export function shouldEvaluateStaleWatchdog(hasActiveSession: boolean, socketConnected: boolean): boolean {
    return hasActiveSession && socketConnected;
}

export interface ViewerDisconnectLike {
    code?: string;
    reason?: string | null;
}

export function shouldStopViewerReconnect(data: ViewerDisconnectLike): boolean {
    return data.code === "snapshot_replay";
}
