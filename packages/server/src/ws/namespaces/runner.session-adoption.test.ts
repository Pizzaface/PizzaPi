import { describe, expect, test } from "bun:test";
import { shouldRejectSessionAdoption } from "./runner.js";

// NOTE: Same constraint as runner.test.ts — no mock.module, no Redis. The
// cluster-wide liveness probe (runner room fetchSockets, fail-closed) lives in
// the session_ready handler; the ownership DECISION is extracted and tested
// here. Covering the decision matrix pins the B-015 regression: a same-user
// second runner must not take over an active session owned by another live
// runner, while first-claim, same-runner reclaim, and dead-runner re-adoption
// keep working.

describe("session_ready adoption guard (B-015 same-user takeover)", () => {
    const session = (runnerId: string | null, isActive = true) => ({ runnerId, isActive });

    test("first association (session has no runnerId) is allowed", () => {
        expect(shouldRejectSessionAdoption(session(null), "runner-b", true)).toBe(false);
    });

    test("missing session record is allowed (existing semantics)", () => {
        expect(shouldRejectSessionAdoption(null, "runner-b", true)).toBe(false);
    });

    test("same runner re-claiming its active session is allowed (reconnect)", () => {
        expect(shouldRejectSessionAdoption(session("runner-a"), "runner-a", true)).toBe(false);
    });

    test("different runner stealing an active session from a LIVE runner is REJECTED", () => {
        // The B-015 attack: runner B (same user) sends session_ready for
        // session S owned by live runner A. Association must stay with A.
        expect(shouldRejectSessionAdoption(session("runner-a"), "runner-b", true)).toBe(true);
    });

    test("different runner adopting from a DEAD runner is allowed (re-adoption)", () => {
        expect(shouldRejectSessionAdoption(session("runner-a"), "runner-b", false)).toBe(false);
    });

    test("different runner adopting an INACTIVE session is allowed (stale association)", () => {
        expect(shouldRejectSessionAdoption(session("runner-a", false), "runner-b", true)).toBe(false);
    });

    test("fail-closed: owner treated as live when liveness is unknown", () => {
        // The handler maps an adapter failure to ownerLive=true; the guard
        // must then reject a different-runner claim on an active session.
        expect(shouldRejectSessionAdoption(session("runner-a"), "runner-b", true)).toBe(true);
    });
});
