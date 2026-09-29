import { describe, expect, test } from "bun:test";
import {
  analyzeIncomingSeq,
  analyzeReplaySeq,
  mergeConnectedSeq,
  shouldAllowOutOfOrderSnapshotDuringHydration,
  shouldDeferEventForHydration,
} from "./session-seq";

describe("mergeConnectedSeq", () => {
  test("uses connected seq when no current seq exists", () => {
    expect(mergeConnectedSeq(null, 12)).toBe(12);
  });

  test("accepts server seq even when lower (seq reset after relay restart)", () => {
    expect(mergeConnectedSeq(15, 12)).toBe(12);
  });

  test("does NOT advance on a bare ack when connected seq is newer", () => {
    // "connected" is emitted before any transcript. Adopting 18 here would claim
    // we hold events 16-18 that were never delivered, and the server would then
    // answer the next resume with "already current" and no content — forever.
    expect(mergeConnectedSeq(15, 18)).toBe(15);
  });

  test("ignores a non-finite server seq", () => {
    expect(mergeConnectedSeq(15, Number.NaN)).toBe(15);
    expect(mergeConnectedSeq(null, Number.NaN)).toBe(0);
  });
});

describe("shouldDeferEventForHydration", () => {
  test("defers streaming deltas while awaiting snapshot", () => {
    expect(shouldDeferEventForHydration("message_update", true)).toBe(true);
    expect(shouldDeferEventForHydration("tool_execution_update", true)).toBe(true);
    expect(shouldDeferEventForHydration("message_end", true)).toBe(true);
  });

  test("applies deltas once hydrated", () => {
    expect(shouldDeferEventForHydration("message_end", false)).toBe(false);
  });

  test("does not defer unrelated event types", () => {
    expect(shouldDeferEventForHydration("heartbeat", true)).toBe(false);
    expect(shouldDeferEventForHydration("session_messages_chunk", true)).toBe(false);
  });
});

describe("shouldAllowOutOfOrderSnapshotDuringHydration", () => {
  test("allows an older snapshot seq after pre-snapshot metadata advanced the cursor", () => {
    expect(shouldAllowOutOfOrderSnapshotDuringHydration("session_active", true, 11, 10)).toBe(true);
    expect(shouldAllowOutOfOrderSnapshotDuringHydration("agent_end", true, 11, 10)).toBe(true);
  });

  test("rejects non-snapshot or non-hydration cases", () => {
    expect(shouldAllowOutOfOrderSnapshotDuringHydration("heartbeat", true, 11, 10)).toBe(false);
    expect(shouldAllowOutOfOrderSnapshotDuringHydration("session_active", false, 11, 10)).toBe(false);
    expect(shouldAllowOutOfOrderSnapshotDuringHydration("session_active", true, null, 10)).toBe(false);
    expect(shouldAllowOutOfOrderSnapshotDuringHydration("session_active", true, 10, 11)).toBe(false);
  });
});

describe("analyzeReplaySeq", () => {
  test("accepts first replay delta when no cursor exists", () => {
    expect(analyzeReplaySeq(null, 5)).toEqual({ accept: true, nextSeq: 5 });
  });

  test("advances cursor for strictly newer replay delta", () => {
    expect(analyzeReplaySeq(5, 6)).toEqual({ accept: true, nextSeq: 6 });
    expect(analyzeReplaySeq(5, 10)).toEqual({ accept: true, nextSeq: 10 });
  });

  test("drops replay delta with same seq as cursor (duplicate)", () => {
    expect(analyzeReplaySeq(5, 5)).toEqual({ accept: false, nextSeq: 5 });
  });

  test("drops stale replay delta (seq < cursor) — live-gap/resync regression", () => {
    // Scenario: live gap advanced cursor to 10. Resync endpoint replays cached
    // deltas starting from an earlier position (e.g. seq 8). These must be
    // dropped, not applied, so the cursor stays at 10.
    expect(analyzeReplaySeq(10, 8)).toEqual({ accept: false, nextSeq: 10 });
    expect(analyzeReplaySeq(10, 9)).toEqual({ accept: false, nextSeq: 10 });
  });

  test("drops non-finite seq", () => {
    expect(analyzeReplaySeq(5, NaN)).toEqual({ accept: false, nextSeq: 5 });
    expect(analyzeReplaySeq(null, NaN)).toEqual({ accept: false, nextSeq: null });
  });

  test("live-gap then replay: cursor never rewinds", () => {
    // Simulate the full scenario:
    // 1. Live events advance cursor 1 → 2 → 3
    // 2. Seq 5 arrives (gap: 4 missing) — cursor jumps to 5
    // 3. Resync is requested. Server replays from seq 3:
    //    replay seq 3 → stale, drop
    //    replay seq 4 → stale, drop
    //    replay seq 5 → stale (already at 5), drop
    //    replay seq 6 → fresh, accept
    let cursor: number | null = null;

    // Live path (use analyzeIncomingSeq for live)
    for (const seq of [1, 2, 3]) {
      const d = analyzeIncomingSeq(cursor, seq);
      expect(d.accept).toBe(true);
      cursor = d.nextSeq;
    }
    expect(cursor).toBe(3);

    // Gap: seq 5 arrives (4 missing)
    const gapDecision = analyzeIncomingSeq(cursor, 5);
    expect(gapDecision.gap).toBe(true);
    expect(gapDecision.accept).toBe(true);
    cursor = gapDecision.nextSeq;
    expect(cursor).toBe(5);

    // Replay of cached deltas — must not rewind
    for (const staleSeq of [3, 4, 5]) {
      const r = analyzeReplaySeq(cursor, staleSeq);
      expect(r.accept).toBe(false);
      cursor = r.nextSeq; // cursor stays at 5
    }
    expect(cursor).toBe(5);

    // First genuinely new replay delta
    const freshReplay = analyzeReplaySeq(cursor, 6);
    expect(freshReplay.accept).toBe(true);
    cursor = freshReplay.nextSeq;
    expect(cursor).toBe(6);
  });
});

describe("analyzeIncomingSeq", () => {
  test("accepts first seq when no cursor exists", () => {
    expect(analyzeIncomingSeq(null, 7)).toEqual({
      accept: true,
      nextSeq: 7,
      gap: false,
      expected: null,
    });
  });

  test("drops older seq", () => {
    expect(analyzeIncomingSeq(10, 9)).toEqual({
      accept: false,
      nextSeq: 10,
      gap: false,
      expected: 11,
    });
  });

  test("accepts same seq without advancing cursor", () => {
    expect(analyzeIncomingSeq(10, 10)).toEqual({
      accept: true,
      nextSeq: 10,
      gap: false,
      expected: 11,
    });
  });

  test("accepts contiguous seq with no gap", () => {
    expect(analyzeIncomingSeq(10, 11)).toEqual({
      accept: true,
      nextSeq: 11,
      gap: false,
      expected: 11,
    });
  });

  test("accepts newer seq and flags gap", () => {
    expect(analyzeIncomingSeq(10, 13)).toEqual({
      accept: true,
      nextSeq: 13,
      gap: true,
      expected: 11,
    });
  });
});
