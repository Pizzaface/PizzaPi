import { describe, expect, test } from "bun:test";
import { isActiveViewerSessionPayload, matchesHydrationGeneration, matchesViewerGeneration } from "./viewer-switch";

describe("matchesViewerGeneration", () => {
  test("accepts payloads without a generation", () => {
    expect(matchesViewerGeneration(3, undefined)).toBe(true);
  });

  test("accepts matching generations", () => {
    expect(matchesViewerGeneration(3, 3)).toBe(true);
  });

  test("rejects stale generations", () => {
    expect(matchesViewerGeneration(3, 2)).toBe(false);
  });

  test("rejects generated payloads when no current generation is set", () => {
    expect(matchesViewerGeneration(undefined, 1)).toBe(false);
  });
});

describe("matchesHydrationGeneration", () => {
  test("accepts an untagged state header while awaiting a cache-miss recovery", () => {
    expect(matchesHydrationGeneration(4, undefined, "session_active", true)).toBe(true);
    expect(matchesHydrationGeneration(4, undefined, "agent_end", true)).toBe(true);
  });

  test("rejects untagged deltas and chunks before the state header", () => {
    expect(matchesHydrationGeneration(4, undefined, "message_update", true)).toBe(false);
    expect(matchesHydrationGeneration(4, undefined, "session_messages_chunk", true)).toBe(false);
  });

  test("still rejects explicitly stale generations", () => {
    expect(matchesHydrationGeneration(4, 3, "session_active", true)).toBe(false);
  });
});

describe("isActiveViewerSessionPayload", () => {
  test("accepts payloads for the active session with matching generation", () => {
    expect(isActiveViewerSessionPayload("sess-a", "sess-a", 4, 4)).toBe(true);
  });

  test("rejects payloads for a different session", () => {
    expect(isActiveViewerSessionPayload("sess-a", "sess-b", 4, 4)).toBe(false);
  });

  test("rejects stale generation payloads even if the session matches", () => {
    expect(isActiveViewerSessionPayload("sess-a", "sess-a", 4, 3)).toBe(false);
  });
});
