// ============================================================================
// sessions.recovery.test.ts — Unit tests for viewer-recovery SQLite-skip path
//
// When a viewer join triggers the cold-start runner fallback (cache miss),
// markPendingRecovery() flags the session and returns a nonce that the runner
// echoes on its recovery session_active. The event-pipeline's
// consumePendingRecovery() clears the flag only on a nonce match and passes
// isRecovery:true to updateSessionState(), which skips the SQLite write.
// Real session_active events (no nonce) must NOT consume the flag.
//
// Imports directly from viewer-recovery.ts — a tiny zero-dependency module.
// No mocking needed: the functions are pure Map operations with no I/O.
// ============================================================================

import { beforeEach, describe, expect, test } from "bun:test";
import {
    markPendingRecovery,
    consumePendingRecovery,
    hasPendingRecovery,
    _resetPendingRecoveriesForTesting,
} from "./viewer-recovery.js";

describe("viewer-recovery SQLite-skip path (pendingRecoveries)", () => {
    beforeEach(() => {
        _resetPendingRecoveriesForTesting();
    });

    test("markPendingRecovery flags a session and returns a nonce", () => {
        const nonce = markPendingRecovery("sess-recover-1");
        expect(typeof nonce).toBe("string");
        expect(nonce.length).toBeGreaterThan(0);
        expect(hasPendingRecovery("sess-recover-1")).toBe(true);
    });

    test("consumePendingRecovery returns true and clears the flag on nonce match", () => {
        const nonce = markPendingRecovery("sess-recover-2");
        const wasRecovery = consumePendingRecovery("sess-recover-2", nonce);
        expect(wasRecovery).toBe(true);
        expect(hasPendingRecovery("sess-recover-2")).toBe(false);
    });

    test("a real session_active (no nonce) does NOT consume the flag", () => {
        const nonce = markPendingRecovery("sess-race");
        // Real update races in first — must persist (false) and leave the flag
        expect(consumePendingRecovery("sess-race", undefined)).toBe(false);
        expect(hasPendingRecovery("sess-race")).toBe(true);
        // Recovery response then matches and consumes
        expect(consumePendingRecovery("sess-race", nonce)).toBe(true);
        expect(hasPendingRecovery("sess-race")).toBe(false);
    });

    test("a mismatched nonce does not consume the flag", () => {
        markPendingRecovery("sess-stale-nonce");
        expect(consumePendingRecovery("sess-stale-nonce", "wrong-nonce")).toBe(false);
        expect(hasPendingRecovery("sess-stale-nonce")).toBe(true);
    });

    test("re-marking replaces the nonce — old nonce no longer matches", () => {
        const oldNonce = markPendingRecovery("sess-remark");
        const newNonce = markPendingRecovery("sess-remark");
        expect(consumePendingRecovery("sess-remark", oldNonce)).toBe(false);
        expect(consumePendingRecovery("sess-remark", newNonce)).toBe(true);
    });

    test("consumePendingRecovery returns false for sessions not marked", () => {
        expect(consumePendingRecovery("sess-not-marked", "any")).toBe(false);
    });

    test("consumePendingRecovery is idempotent — second call returns false", () => {
        const nonce = markPendingRecovery("sess-recover-3");
        expect(consumePendingRecovery("sess-recover-3", nonce)).toBe(true);
        expect(consumePendingRecovery("sess-recover-3", nonce)).toBe(false); // already consumed
    });

    test("multiple sessions tracked independently", () => {
        const nonceA = markPendingRecovery("sess-a");
        const nonceB = markPendingRecovery("sess-b");

        expect(consumePendingRecovery("sess-a", nonceA)).toBe(true);
        expect(hasPendingRecovery("sess-b")).toBe(true); // unaffected
        expect(consumePendingRecovery("sess-b", nonceB)).toBe(true);
        expect(hasPendingRecovery("sess-a")).toBe(false);
        expect(hasPendingRecovery("sess-b")).toBe(false);
    });
});
