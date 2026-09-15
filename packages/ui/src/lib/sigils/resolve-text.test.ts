import { describe, expect, test } from "bun:test";
import { resolveSigilsToText } from "./resolve-text";

describe("resolveSigilsToText", () => {
  test("replaces resolved sigils and preserves surrounding text", async () => {
    const result = await resolveSigilsToText(
      "See [[pr:42]] and [[issue:7]].",
      async (match) => `${match.type.toUpperCase()} ${match.id}`,
    );

    expect(result).toBe("See PR 42 and ISSUE 7.");
  });

  test("uses the original token when resolution is unavailable", async () => {
    const result = await resolveSigilsToText(
      "See [[pr:42]] and [[unknown:x]].",
      (match) => match.type === "pr" ? "Fix the bug" : undefined,
    );

    expect(result).toBe("See Fix the bug and [[unknown:x]].");
  });

  test("does not resolve sigils inside code", async () => {
    const result = await resolveSigilsToText(
      "Use `[[pr:42]]` or [[pr:43]].",
      () => "resolved",
    );

    expect(result).toBe("Use `[[pr:42]]` or resolved.");
  });

  test("keeps the token when a resolver rejects", async () => {
    const result = await resolveSigilsToText(
      "[[pr:42]]",
      async () => { throw new Error("offline"); },
    );

    expect(result).toBe("[[pr:42]]");
  });
});
