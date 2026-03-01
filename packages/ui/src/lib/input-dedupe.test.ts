import { describe, expect, test } from "bun:test";
import {
  beginInputAttempt,
  completeInputAttempt,
  failInputAttempt,
  shouldDeduplicateInput,
  type InputDedupeState,
} from "./input-dedupe";

describe("input dedupe state", () => {
  test("deduplicates same text while an attempt is pending", () => {
    const state = beginInputAttempt("hello", 1000, 1);

    expect(shouldDeduplicateInput(state, "hello", 1200, 500)).toBe(true);
    expect(shouldDeduplicateInput(state, "hello", 1600, 500)).toBe(false);
  });

  test("clears pending marker on failure so immediate retry is allowed", () => {
    const pending = beginInputAttempt("hello", 1000, 1);
    const failed = failInputAttempt(pending, 1);

    expect(failed).toBeNull();
    expect(shouldDeduplicateInput(failed, "hello", 1100, 500)).toBe(false);
  });

  test("marks sent on success and deduplicates immediate retries", () => {
    const pending = beginInputAttempt("hello", 1000, 1);
    const sent = completeInputAttempt(pending, 1, 1200);

    expect(sent).toEqual({
      text: "hello",
      ts: 1200,
      phase: "sent",
      attemptId: 1,
    } satisfies InputDedupeState);
    expect(shouldDeduplicateInput(sent, "hello", 1300, 500)).toBe(true);
  });

  test("keeps newer pending attempt when older attempt fails later", () => {
    const first = beginInputAttempt("hello", 1000, 1);
    const second = beginInputAttempt("hello", 1050, 2);

    // Older attempt should not clear the newer pending marker.
    expect(failInputAttempt(second, first.attemptId)).toEqual(second);
  });

  test("does not deduplicate different text", () => {
    const state = beginInputAttempt("hello", 1000, 1);

    expect(shouldDeduplicateInput(state, "world", 1100, 500)).toBe(false);
  });
});
