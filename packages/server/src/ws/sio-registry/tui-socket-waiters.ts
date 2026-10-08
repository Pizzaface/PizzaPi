// ============================================================================
// tui-socket-waiters.ts — event-driven waiters for TUI socket registration
//
// Event-driven replacement for 200ms polling loops that wait for a freshly
// spawned session's TUI socket to register. Zero-dependency module (pure Map
// operations) so tests can import it directly without mocking.
// ============================================================================

interface SocketLike {
    connected: boolean;
}

const tuiSocketWaiters = new Map<string, Set<() => void>>();

/** Resolve any waiters for a session whose TUI socket just registered. */
export function notifyTuiSocketConnected(sessionId: string): void {
    const waiters = tuiSocketWaiters.get(sessionId);
    if (!waiters) return;
    tuiSocketWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
}

/**
 * Resolve true as soon as the session's TUI socket is connected (per
 * `getSocket`), or false after timeoutMs.
 */
export function waitForTuiSocket(
    sessionId: string,
    timeoutMs: number,
    getSocket: (sessionId: string) => SocketLike | undefined,
    signal?: AbortSignal,
): Promise<boolean> {
    if (getSocket(sessionId)?.connected) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        let waiters = tuiSocketWaiters.get(sessionId);
        if (!waiters) {
            waiters = new Set();
            tuiSocketWaiters.set(sessionId, waiters);
        }
        const cleanup = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            const set = tuiSocketWaiters.get(sessionId);
            set?.delete(onConnect);
            if (set && set.size === 0) tuiSocketWaiters.delete(sessionId);
        };
        const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const onConnect = (): void => finish(true);
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(onConnect);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Clear all waiters. For test isolation only. */
export function _resetTuiSocketWaitersForTesting(): void {
    tuiSocketWaiters.clear();
}
