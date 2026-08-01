// ============================================================================
// viewer-recovery.ts — in-memory flags for viewer-triggered session recovery
//
// When a viewer cache miss forces the server to ask the runner for a fresh
// session_active snapshot, the follow-up event is recovery data rather than
// new agent activity. These helpers track that one-shot condition so the event
// pipeline can skip redundant SQLite writes.
//
// Each pending recovery carries a nonce that is sent to the runner in the
// "connected" payload and echoed back on the recovery session_active. Only a
// session_active carrying the matching nonce consumes the flag — a real
// (non-recovery) session_active racing in first must NOT consume it, or a
// genuine state update would skip SQLite persistence and could be lost on
// crash. Runners that don't echo the nonce simply never match; the flag
// expires via TTL and their recovery snapshots get persisted (harmless
// extra write).
// ============================================================================

import { randomUUID } from "node:crypto";

interface PendingRecovery {
    nonce: string;
    ts: number;
}

const pendingRecoveries = new Map<string, PendingRecovery>();
const RECOVERY_FLAG_TTL_MS = 60_000;

function sweepStalePendingRecoveries(): void {
    const now = Date.now();
    for (const [sessionId, entry] of pendingRecoveries) {
        if (now - entry.ts > RECOVERY_FLAG_TTL_MS) {
            pendingRecoveries.delete(sessionId);
        }
    }
}

/**
 * Mark a session as expecting a recovery-origin session_active.
 * Returns the nonce to include in the runner "connected" payload.
 */
export function markPendingRecovery(sessionId: string): string {
    sweepStalePendingRecoveries();
    const nonce = randomUUID();
    pendingRecoveries.set(sessionId, { nonce, ts: Date.now() });
    return nonce;
}

/**
 * Check and consume the recovery flag for a session.
 * Only consumes (and returns true) when the session_active echoed the
 * matching recovery nonce — events without a nonce (real agent updates,
 * or runners that predate nonce echoing) never match.
 * Stale entries (older than RECOVERY_FLAG_TTL_MS) are evicted and treated
 * as absent, so a missed recovery snapshot never permanently marks a
 * session as recovering.
 */
export function consumePendingRecovery(sessionId: string, nonce: string | undefined): boolean {
    const entry = pendingRecoveries.get(sessionId);
    if (entry === undefined) return false;
    if (Date.now() - entry.ts > RECOVERY_FLAG_TTL_MS) {
        pendingRecoveries.delete(sessionId);
        return false;
    }
    if (nonce === undefined || nonce !== entry.nonce) return false;
    pendingRecoveries.delete(sessionId);
    return true;
}

/**
 * Check whether a session has a pending recovery flag (non-consuming).
 * Evicts the entry if it is stale (older than RECOVERY_FLAG_TTL_MS).
 */
export function hasPendingRecovery(sessionId: string): boolean {
    const entry = pendingRecoveries.get(sessionId);
    if (entry === undefined) return false;
    if (Date.now() - entry.ts > RECOVERY_FLAG_TTL_MS) {
        pendingRecoveries.delete(sessionId);
        return false;
    }
    return true;
}

/** Clear all pending recovery flags. For test isolation only. */
export function _resetPendingRecoveriesForTesting(): void {
    pendingRecoveries.clear();
}
