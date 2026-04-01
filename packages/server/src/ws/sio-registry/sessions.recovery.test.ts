// ============================================================================
// sessions.recovery.test.ts — Unit tests for viewer-recovery SQLite-skip path
//
// When a viewer join triggers the cold-start runner fallback (cache miss),
// markPendingRecovery() flags the session in pendingRecoverySessionIds.
// The event-pipeline's consumePendingRecovery() clears the flag and passes
// isRecovery:true to updateSessionState(), which skips the SQLite write.
//
// Imports directly from viewer-recovery.ts — a tiny zero-dependency module.
// No mocking needed: the functions are pure Set operations with no I/O.
// ============================================================================

import { beforeEach, describe, expect, test } from "bun:test";
import {
    markPendingRecovery,
    consumePendingRecovery,
    pendingRecoverySessionIds,
} from "./viewer-recovery.js";

describe("viewer-recovery SQLite-skip path (pendingRecoverySessionIds)", () => {
    beforeEach(() => {
        pendingRecoverySessionIds.clear();
    });

    test("markPendingRecovery flags a session for recovery", () => {
        markPendingRecovery("sess-recover-1");
        expect(pendingRecoverySessionIds.has("sess-recover-1")).toBe(true);
    });

    test("consumePendingRecovery returns true and clears the flag", () => {
        markPendingRecovery("sess-recover-2");
        const wasRecovery = consumePendingRecovery("sess-recover-2");
        expect(wasRecovery).toBe(true);
        expect(pendingRecoverySessionIds.has("sess-recover-2")).toBe(false);
    });

    test("consumePendingRecovery returns false for sessions not marked", () => {
        const wasRecovery = consumePendingRecovery("sess-not-marked");
        expect(wasRecovery).toBe(false);
    });

    test("consumePendingRecovery is idempotent — second call returns false", () => {
        markPendingRecovery("sess-recover-3");
        expect(consumePendingRecovery("sess-recover-3")).toBe(true);
        expect(consumePendingRecovery("sess-recover-3")).toBe(false); // already consumed
    });

    test("multiple sessions tracked independently", () => {
        markPendingRecovery("sess-a");
        markPendingRecovery("sess-b");

        expect(consumePendingRecovery("sess-a")).toBe(true);
        expect(pendingRecoverySessionIds.has("sess-b")).toBe(true); // unaffected
        expect(consumePendingRecovery("sess-b")).toBe(true);
        expect(pendingRecoverySessionIds.size).toBe(0);
    });
});
