// ============================================================================
// viewer-recovery.ts — in-memory flags for viewer-triggered session recovery
//
// When a viewer cache miss forces the server to ask the runner for a fresh
// session_active snapshot, the follow-up event is recovery data rather than
// new agent activity. These helpers track that one-shot condition so the event
// pipeline can skip redundant SQLite writes.
// ============================================================================

const pendingRecoveryTimestamps = new Map<string, number>();
const RECOVERY_FLAG_TTL_MS = 60_000;

function sweepStalePendingRecoveries(): void {
    const now = Date.now();
    for (const [sessionId, ts] of pendingRecoveryTimestamps) {
        if (now - ts > RECOVERY_FLAG_TTL_MS) {
            pendingRecoveryTimestamps.delete(sessionId);
        }
    }
}

/** Mark a session as expecting a recovery-origin session_active. */
export function markPendingRecovery(sessionId: string): void {
    sweepStalePendingRecoveries();
    pendingRecoveryTimestamps.set(sessionId, Date.now());
}

/**
 * Check and consume the recovery flag for a session.
 * Returns true (and removes the flag) if the session had a non-stale pending recovery.
 * Stale entries (older than RECOVERY_FLAG_TTL_MS) are evicted and treated as absent,
 * so a missed recovery snapshot never permanently marks a session as recovering.
 */
export function consumePendingRecovery(sessionId: string): boolean {
    const ts = pendingRecoveryTimestamps.get(sessionId);
    if (ts === undefined) return false;
    pendingRecoveryTimestamps.delete(sessionId);
    return Date.now() - ts <= RECOVERY_FLAG_TTL_MS;
}

/**
 * Check whether a session has a pending recovery flag (non-consuming).
 * Evicts the entry if it is stale (older than RECOVERY_FLAG_TTL_MS).
 */
export function hasPendingRecovery(sessionId: string): boolean {
    const ts = pendingRecoveryTimestamps.get(sessionId);
    if (ts === undefined) return false;
    if (Date.now() - ts > RECOVERY_FLAG_TTL_MS) {
        pendingRecoveryTimestamps.delete(sessionId);
        return false;
    }
    return true;
}

/** Clear all pending recovery flags. For test isolation only. */
export function _resetPendingRecoveriesForTesting(): void {
    pendingRecoveryTimestamps.clear();
}
