/**
 * Tests for the session_killed → pendingSessionChecks race-condition fix.
 *
 * These tests use only the exported pure helper `rejectPendingSessionCheck`
 * and hand-simulated Maps, avoiding mock.module so they don't pollute other
 * test files (see NOTE in runner.test.ts about process-global module mocks).
 */
import { describe, expect, test } from "bun:test";
import { rejectPendingSessionCheck } from "./runner.js";

// ─── Helper to build a minimal pending-check entry ───────────────────────────

function makePendingEntry(runnerId: string) {
    let rejectFn!: () => void;
    let resolveFn!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    // Suppress unhandled-rejection noise — the test controls settlement.
    promise.catch(() => {});
    return { promise, reject: rejectFn, resolve: resolveFn, runnerId };
}

// ─── Unit tests for rejectPendingSessionCheck ─────────────────────────────────

describe("rejectPendingSessionCheck", () => {
    test("rejects and deletes a matching entry", () => {
        const checks = new Map<string, { promise: Promise<void>; reject: () => void; runnerId: string }>();
        const entry = makePendingEntry("runner-1");
        checks.set("session-a", entry);

        const rejected: string[] = [];
        const trackedEntry = { ...entry, reject: () => rejected.push("session-a") };
        checks.set("session-a", trackedEntry);

        const result = rejectPendingSessionCheck(checks, "session-a", "runner-1");

        expect(result).toBe(true);
        expect(checks.has("session-a")).toBe(false);
        expect(rejected).toEqual(["session-a"]);
    });

    test("does nothing when runnerId does not match", () => {
        const checks = new Map<string, { promise: Promise<void>; reject: () => void; runnerId: string }>();
        const entry = makePendingEntry("runner-1");
        const rejected: string[] = [];
        checks.set("session-a", { ...entry, reject: () => rejected.push("called") });

        const result = rejectPendingSessionCheck(checks, "session-a", "runner-2");

        expect(result).toBe(false);
        expect(checks.has("session-a")).toBe(true); // untouched
        expect(rejected).toEqual([]); // reject NOT called
    });

    test("does nothing when sessionId is absent", () => {
        const checks = new Map<string, { promise: Promise<void>; reject: () => void; runnerId: string }>();
        const result = rejectPendingSessionCheck(checks, "no-such-session", "runner-1");
        expect(result).toBe(false);
    });

    test("does not affect entries for other sessions on the same runner", () => {
        const checks = new Map<string, { promise: Promise<void>; reject: () => void; runnerId: string }>();
        checks.set("session-a", makePendingEntry("runner-1"));
        checks.set("session-b", makePendingEntry("runner-1"));

        rejectPendingSessionCheck(checks, "session-a", "runner-1");

        expect(checks.has("session-a")).toBe(false);
        expect(checks.has("session-b")).toBe(true); // unaffected
    });
});

// ─── Race-condition harness ───────────────────────────────────────────────────
// Simulates: session_ready fires → getSharedSession() starts (async) →
// session_killed fires mid-flight → getSharedSession() resolves →
// session_ready continuation must NOT add the session to runnerSessionIds.

describe("session_killed race condition", () => {
    test("session not added to runnerSessionIds when killed while check is in-flight", async () => {
        // ── State that mirrors the closure inside registerRunnerNamespace ──
        const pendingSessionChecks = new Map<
            string,
            { promise: Promise<void>; reject: () => void; runnerId: string }
        >();
        const runnerSessionIds = new Map<string, Set<string>>();

        const sessionId = "session-race";
        const runnerId = "runner-race";

        // ── Simulate session_ready: register pending check ─────────────────
        let resolveCheck!: () => void;
        let rejectCheck!: () => void;
        const checkPromise = new Promise<void>((res, rej) => {
            resolveCheck = res;
            rejectCheck = rej;
        });
        checkPromise.catch(() => {}); // suppress unhandled-rejection

        pendingSessionChecks.set(sessionId, { promise: checkPromise, reject: rejectCheck, runnerId });

        // Hold a reference to the entry at set-time so session_ready can compare.
        // (In production code the continuation checks `pendingSessionChecks.has`.)

        // ── Simulate getSharedSession() in-flight ──────────────────────────
        // (We'll resolve it after session_killed fires.)

        // ── Simulate session_killed ────────────────────────────────────────
        // This is exactly what the fixed handler does:
        const wasRejected = rejectPendingSessionCheck(pendingSessionChecks, sessionId, runnerId);
        // Remove from local tracking (would also happen for runnerSessionIds, but it's empty here)
        runnerSessionIds.get(runnerId)?.delete(sessionId);

        expect(wasRejected).toBe(true);
        expect(pendingSessionChecks.has(sessionId)).toBe(false);

        // ── getSharedSession() resolves (ownership confirmed) ──────────────
        // The session_ready continuation now runs. It checks !socket.connected
        // (false — socket is still up), then checks pendingSessionChecks.has():
        const socketConnected = true; // socket is still alive
        const pendingStillPresent = pendingSessionChecks.has(sessionId);

        // Guard: session_killed already removed our entry — bail without adding.
        if (socketConnected && !pendingStillPresent) {
            // do NOT add to runnerSessionIds
        } else {
            pendingSessionChecks.delete(sessionId);
            if (!runnerSessionIds.has(runnerId)) runnerSessionIds.set(runnerId, new Set());
            runnerSessionIds.get(runnerId)!.add(sessionId);
            resolveCheck();
        }

        // ── Assertion: session must NOT be in runnerSessionIds ─────────────
        expect(runnerSessionIds.get(runnerId)?.has(sessionId)).toBeFalsy();
    });

    test("session IS added normally when no kill fires", async () => {
        const pendingSessionChecks = new Map<
            string,
            { promise: Promise<void>; reject: () => void; runnerId: string }
        >();
        const runnerSessionIds = new Map<string, Set<string>>();

        const sessionId = "session-ok";
        const runnerId = "runner-ok";

        let resolveCheck!: () => void;
        let rejectCheck!: () => void;
        const checkPromise = new Promise<void>((res, rej) => {
            resolveCheck = res;
            rejectCheck = rej;
        });
        checkPromise.catch(() => {});

        pendingSessionChecks.set(sessionId, { promise: checkPromise, reject: rejectCheck, runnerId });

        // session_killed does NOT fire.

        // getSharedSession resolves — simulate session_ready continuation:
        const socketConnected = true;
        const pendingStillPresent = pendingSessionChecks.has(sessionId);

        if (socketConnected && !pendingStillPresent) {
            // bail (not taken in this test)
        } else {
            pendingSessionChecks.delete(sessionId);
            if (!runnerSessionIds.has(runnerId)) runnerSessionIds.set(runnerId, new Set());
            runnerSessionIds.get(runnerId)!.add(sessionId);
            resolveCheck();
        }

        expect(runnerSessionIds.get(runnerId)?.has(sessionId)).toBe(true);
    });
});
