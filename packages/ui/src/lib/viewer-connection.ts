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

/**
 * Backoff multiplier applied to the stale-connection threshold after N
 * consecutive watchdog-triggered reconnects produced no proof the runner is
 * actually alive. A dead runner's viewer connection still gets a "connected"
 * ack and a replayed, stale heartbeat on every reconnect (the server replays
 * its last cached heartbeat — see withLivenessOnlyHint in viewer.ts — even
 * when the runner that produced it is long gone). Naively treating that as a
 * fresh event resets the stale timer, so the watchdog would otherwise fire
 * again at the same fixed cadence forever. Doubling the threshold on each
 * unproductive reconnect (capped) turns that into a decaying retry; a single
 * event that actually proves liveness resets the count back to 0.
 */
export function staleWatchdogBackoffMultiplier(consecutiveStaleReconnects: number, maxMultiplier = 8): number {
    return Math.min(2 ** Math.max(0, consecutiveStaleReconnects), maxMultiplier);
}

/**
 * Whether the stale-connection watchdog should reconnect this tick, given
 * how long it's been since the last event and how many consecutive
 * reconnects already failed to turn up proof of life.
 */
export function shouldTriggerStaleWatchdogReconnect(
    elapsedMs: number,
    baseThresholdMs: number,
    consecutiveStaleReconnects: number,
): boolean {
    return elapsedMs > baseThresholdMs * staleWatchdogBackoffMultiplier(consecutiveStaleReconnects);
}

/**
 * Whether an app-resume signal (Capacitor's appStateChange) should force a
 * full socket teardown+reconnect, vs. just nudging an already-disconnected
 * socket to connect(). appStateChange fires on every foreground transition,
 * including harmless ones that never left the socket stale — iOS Control
 * Center, the notification shade, a permission dialog. Forcing a teardown on
 * every one of those kills in-flight requests (emitInputWithAck callers see
 * "Failed to send message") and forces a full re-hydration for nothing. Only
 * force it once enough time has passed that the connection could plausibly
 * be stale — the same signal the stale-connection watchdog uses.
 */
export function shouldForceReconnectOnResume(lastEventAtMs: number, nowMs: number, heartbeatIntervalMs: number): boolean {
    return nowMs - lastEventAtMs > heartbeatIntervalMs * 1.5;
}

/**
 * Whether an incoming viewer event proves the runner that owns the session
 * is actually alive, and so should reset the stale-watchdog backoff counter.
 *
 * Three kinds of events reach the viewer without any live runner involved:
 * a liveness-only replayed heartbeat (withLivenessOnlyHint in viewer.ts), a
 * cache-hydration snapshot replay (tryCacheSnapshot, envelope.replay), and
 * its trailing cached deltas (sendCachedDeltaReplayEvents, envelope.deltaReplay).
 * All three are served straight from Redis/cache on reconnect regardless of
 * whether the runner is dead, so counting them as proof of life lets a dead
 * runner's cursor-less reconnect replay a cached snapshot every stale tick,
 * resetting the counter back to 0 and turning the backoff into a permanent
 * 30-45s reconnect loop instead of decaying.
 */
export function shouldResetStaleBackoffOnEvent(
    isLivenessOnlyHeartbeat: boolean,
    isReplay: boolean,
    isDeltaReplay: boolean,
): boolean {
    return !isLivenessOnlyHeartbeat && !isReplay && !isDeltaReplay;
}
