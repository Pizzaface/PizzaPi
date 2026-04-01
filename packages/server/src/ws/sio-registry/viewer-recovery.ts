// ============================================================================
// viewer-recovery.ts — in-memory flags for viewer-triggered session recovery
//
// When a viewer cache miss forces the server to ask the runner for a fresh
// session_active snapshot, the follow-up event is recovery data rather than
// new agent activity. These helpers track that one-shot condition so the event
// pipeline can skip redundant SQLite writes.
// ============================================================================

export const pendingRecoverySessionIds = new Set<string>();

/** Mark a session as expecting a recovery-origin session_active. */
export function markPendingRecovery(sessionId: string): void {
    pendingRecoverySessionIds.add(sessionId);
}

/**
 * Check and consume the recovery flag for a session.
 * Returns true (and removes the flag) if the session had a pending recovery.
 */
export function consumePendingRecovery(sessionId: string): boolean {
    return pendingRecoverySessionIds.delete(sessionId);
}
