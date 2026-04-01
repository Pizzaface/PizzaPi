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
 * Returns true (and removes the flag) if the session had a pending recovery.
 */
export function consumePendingRecovery(sessionId: string): boolean {
    const has = pendingRecoveryTimestamps.has(sessionId);
    pendingRecoveryTimestamps.delete(sessionId);
    return has;
}

/** Check whether a session has a pending recovery flag (non-consuming). */
export function hasPendingRecovery(sessionId: string): boolean {
    return pendingRecoveryTimestamps.has(sessionId);
}

/** Clear all pending recovery flags. For test isolation only. */
export function _resetPendingRecoveriesForTesting(): void {
    pendingRecoveryTimestamps.clear();
}
