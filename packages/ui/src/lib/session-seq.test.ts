import { describe, expect, test } from "bun:test";
import { analyzeIncomingSeq, mergeConnectedSeq, shouldDeferEventForHydration } from "./session-seq";

describe("mergeConnectedSeq", () => {
  test("uses connected seq when no current seq exists", () => {
    expect(mergeConnectedSeq(null, 12)).toBe(12);
  });

  test("never rewinds when connected seq is older", () => {
    expect(mergeConnectedSeq(15, 12)).toBe(15);
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
