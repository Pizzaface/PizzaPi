import { describe, expect, test } from "bun:test";
import { mergeConnectedSeq } from "./session-seq";

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
