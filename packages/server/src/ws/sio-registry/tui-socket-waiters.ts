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
): Promise<boolean> {
    if (getSocket(sessionId)?.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
        let waiters = tuiSocketWaiters.get(sessionId);
        if (!waiters) {
            waiters = new Set();
            tuiSocketWaiters.set(sessionId, waiters);
        }
        const onConnect = (): void => {
            clearTimeout(timer);
            resolve(true);
        };
        const timer = setTimeout(() => {
            const set = tuiSocketWaiters.get(sessionId);
            set?.delete(onConnect);
            if (set && set.size === 0) tuiSocketWaiters.delete(sessionId);
            resolve(false);
        }, timeoutMs);
        waiters.add(onConnect);
    });
}

/** Clear all waiters. For test isolation only. */
export function _resetTuiSocketWaitersForTesting(): void {
    tuiSocketWaiters.clear();
}
