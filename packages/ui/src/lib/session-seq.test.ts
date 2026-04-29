import { describe, expect, test } from "bun:test";
import {
  analyzeIncomingSeq,
  canFinalizeChunkHydration,
  mergeConnectedSeq,
  registerChunkIndex,
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

  test("advances when connected seq is newer", () => {
    expect(mergeConnectedSeq(15, 18)).toBe(18);
  });
});

describe("shouldDeferEventForHydration", () => {
  test("defers streaming deltas while awaiting snapshot", () => {
    expect(shouldDeferEventForHydration("message_update", true, false)).toBe(true);
    expect(shouldDeferEventForHydration("tool_execution_update", true, false)).toBe(true);
  });

  test("defers streaming deltas during chunked hydration", () => {
    expect(shouldDeferEventForHydration("message_end", false, true)).toBe(true);
  });

  test("defers chunks before chunked header arrives", () => {
    expect(shouldDeferEventForHydration("session_messages_chunk", true, false)).toBe(true);
  });

  test("accepts chunks after chunked header is active", () => {
    expect(shouldDeferEventForHydration("session_messages_chunk", true, true)).toBe(false);
  });

  test("does not defer unrelated event types", () => {
    expect(shouldDeferEventForHydration("heartbeat", true, false)).toBe(false);
  });
});

describe("chunk index tracking", () => {
  test("registerChunkIndex is idempotent for duplicate chunk indexes", () => {
    const seen = new Set<number>();

    expect(registerChunkIndex(seen, 0)).toBe(true);
    expect(registerChunkIndex(seen, 0)).toBe(false);
    expect(Array.from(seen)).toEqual([0]);
  });

  test("canFinalizeChunkHydration requires all unique indexes", () => {
    const seen = new Set<number>();
    registerChunkIndex(seen, 0);
    registerChunkIndex(seen, 2);

    expect(canFinalizeChunkHydration(true, seen, 3)).toBe(false);

    registerChunkIndex(seen, 1);
    expect(canFinalizeChunkHydration(true, seen, 3)).toBe(true);
  });

  test("does not finalize until a final chunk has been seen", () => {
    const seen = new Set<number>();
    registerChunkIndex(seen, 0);
    registerChunkIndex(seen, 1);

    expect(canFinalizeChunkHydration(false, seen, 2)).toBe(false);
    expect(canFinalizeChunkHydration(true, seen, 2)).toBe(true);
  });

  test("out-of-order chunk indexes finalize once 0..N-1 are present", () => {
    const seen = new Set<number>();
    registerChunkIndex(seen, 2);
    registerChunkIndex(seen, 0);

    expect(canFinalizeChunkHydration(true, seen, 3)).toBe(false);

    registerChunkIndex(seen, 1);
    expect(canFinalizeChunkHydration(true, seen, 3)).toBe(true);
  });

  test("consumer chunk buffer assembled in index order preserves original message sequence", () => {
    // Simulates the Map<number, unknown[]> buffer pattern used by the UI
    // chunk hydration handler.  Chunks arrive out of order (2 → 0 → 1) but
    // the assembled transcript must reflect original order (0 → 1 → 2).
    const seen = new Set<number>();
    const chunkBuffer = new Map<number, string[]>();

    // Arrival order: chunk 2 first, then 0, then 1
    registerChunkIndex(seen, 2);
    chunkBuffer.set(2, ["msg-c2-a", "msg-c2-b"]);

    registerChunkIndex(seen, 0);
    chunkBuffer.set(0, ["msg-c0-a"]);

    registerChunkIndex(seen, 1);
    chunkBuffer.set(1, ["msg-c1-a", "msg-c1-b"]);

    expect(canFinalizeChunkHydration(true, seen, 3)).toBe(true);

    // Sort by chunkIndex, then flatten — must equal original server-side order
    const sortedIndexes = Array.from(chunkBuffer.keys()).sort((a, b) => a - b);
    const assembled = sortedIndexes.flatMap((idx) => chunkBuffer.get(idx)!);

    expect(assembled).toEqual(["msg-c0-a", "msg-c1-a", "msg-c1-b", "msg-c2-a", "msg-c2-b"]);
    // Arrival order [2, 0, 1] must NOT be reflected in the final transcript
    expect(assembled[0]).toBe("msg-c0-a");
    expect(assembled[assembled.length - 1]).toBe("msg-c2-b");
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
