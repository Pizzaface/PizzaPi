/**
 * Regression tests for the live-gap/resync cursor-rewind bug (A2-007).
 *
 * Problem: When a live sequence gap was detected the UI emitted a "resync"
 * request, which caused the server to replay cached deltas starting from
 * the last stored cursor. But the replay path in App.tsx unconditionally
 * assigned `lastSeqRef.current = seq`, so any replayed delta with a seq
 * older than the cursor (which had already advanced to accommodate the
 * live gap event) rewound the cursor and re-applied stale state.
 *
 * Fix: The replay path now routes through `analyzeReplaySeq`, which only
 * accepts deltas with seq strictly greater than the current cursor.
 *
 * These tests verify the pure guard logic that App.tsx delegates to.
 * The React component integration is covered by the guard itself — if
 * analyzeReplaySeq returns accept:false, App.tsx returns early without
 * calling handleRelayEvent or advancing lastSeqRef.
 */

import { describe, expect, test } from "bun:test";
import { analyzeIncomingSeq, analyzeReplaySeq } from "./lib/session-seq";

describe("resync replay cursor-rewind regression (A2-007)", () => {
  test("live gap advances cursor; subsequent stale replay deltas are dropped", () => {
    let cursor: number | null = null;

    // ── Normal live delivery ──────────────────────────────────────────────
    for (const seq of [1, 2, 3]) {
      const d = analyzeIncomingSeq(cursor, seq);
      expect(d.accept).toBe(true);
      cursor = d.nextSeq;
    }
    expect(cursor).toBe(3);

    // ── Live gap: seq 5 arrives (4 was missing) ──────────────────────────
    const gap = analyzeIncomingSeq(cursor, 5);
    expect(gap.gap).toBe(true);    // gap detected → UI would request resync
    expect(gap.accept).toBe(true);
    cursor = gap.nextSeq;
    expect(cursor).toBe(5);        // cursor now at 5

    // ── Resync: server replays cached deltas from an earlier position ─────
    // Deltas seq 3, 4, 5 are "older" than our current cursor (5).
    // Before the fix: these would each unconditionally set cursor = seq,
    //   causing cursor to rewind from 5 → 3, then 4, then 5.
    // After the fix: all three are dropped; cursor stays at 5.
    for (const staleSeq of [3, 4, 5]) {
      const r = analyzeReplaySeq(cursor, staleSeq);
      expect(r.accept).toBe(false);  // stale — must be dropped
      cursor = r.nextSeq;            // cursor unchanged
    }
    expect(cursor).toBe(5);          // ← was 3 before the fix

    // ── First genuinely new replay delta ─────────────────────────────────
    const fresh = analyzeReplaySeq(cursor, 6);
    expect(fresh.accept).toBe(true);
    cursor = fresh.nextSeq;
    expect(cursor).toBe(6);
  });

  test("replay drops duplicate seq (equal to cursor)", () => {
    // cursor already at 10; replay sends seq 10 again — must be dropped
    const r = analyzeReplaySeq(10, 10);
    expect(r.accept).toBe(false);
    expect(r.nextSeq).toBe(10);
  });

  test("normal contiguous replay still advances cursor", () => {
    // Fresh connection: no cursor yet; replay delivers 1, 2, 3 in order
    let cursor: number | null = null;
    for (const seq of [1, 2, 3]) {
      const r = analyzeReplaySeq(cursor, seq);
      expect(r.accept).toBe(true);
      cursor = r.nextSeq;
    }
    expect(cursor).toBe(3);
  });
});
