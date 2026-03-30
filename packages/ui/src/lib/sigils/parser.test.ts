import { describe, test, expect } from "bun:test";
import { parseSigils } from "./parser";

describe("parseSigils", () => {
  test("returns empty for text without sigils", () => {
    expect(parseSigils("hello world")).toEqual([]);
    expect(parseSigils("")).toEqual([]);
    expect(parseSigils("some [[incomplete")).toEqual([]);
  });

  test("parses basic sigil", () => {
    const matches = parseSigils("See [[pr:55]]");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("pr");
    expect(matches[0].id).toBe("55");
    expect(matches[0].params).toEqual({});
    expect(matches[0].raw).toBe("[[pr:55]]");
  });

  test("parses sigil with no id", () => {
    const matches = parseSigils("[[status:]]");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("status");
    expect(matches[0].id).toBe("");
  });

  test("parses file paths as id", () => {
    const matches = parseSigils("[[file:src/auth/login.ts]]");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("file");
    expect(matches[0].id).toBe("src/auth/login.ts");
  });

  test("parses unquoted params", () => {
    const matches = parseSigils("[[pr:55 status=merged]]");
    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({ status: "merged" });
  });

  test("parses quoted params", () => {
    const matches = parseSigils('[[pr:55 label="Add auth flow"]]');
    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({ label: "Add auth flow" });
  });

  test("parses multiple params", () => {
    const matches = parseSigils('[[pr:55 status=merged label="Add auth"]]');
    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({ status: "merged", label: "Add auth" });
  });

  test("parses multiple sigils in one string", () => {
    const matches = parseSigils("Branch [[branch:main]] has [[pr:55]]");
    expect(matches).toHaveLength(2);
    expect(matches[0].type).toBe("branch");
    expect(matches[0].id).toBe("main");
    expect(matches[1].type).toBe("pr");
    expect(matches[1].id).toBe("55");
  });

  test("normalizes type to lowercase", () => {
    const matches = parseSigils("[[PR:55]]");
    expect(matches[0].type).toBe("pr");
  });

  test("handles hyphenated types", () => {
    const matches = parseSigils("[[pull-request:55]]");
    expect(matches[0].type).toBe("pull-request");
  });

  test("records correct offsets", () => {
    const text = "see [[pr:55]] here";
    const matches = parseSigils(text);
    expect(matches[0].start).toBe(4);
    expect(matches[0].end).toBe(13);
    expect(text.slice(matches[0].start, matches[0].end)).toBe("[[pr:55]]");
  });

  test("skips sigils inside inline code", () => {
    const matches = parseSigils("Use `[[pr:55]]` in your text");
    expect(matches).toHaveLength(0);
  });

  test("skips sigils inside fenced code blocks", () => {
    const text = "Before\n```\n[[pr:55]]\n```\nAfter [[branch:main]]";
    const matches = parseSigils(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("branch");
  });

  test("rejects nested brackets", () => {
    // [[foo:[[bar]]]] should not match as a valid sigil
    const matches = parseSigils("[[foo:[[bar]]]]");
    // The regex won't match this as a single sigil — it might partially match
    // but should not produce a clean foo:[[bar]] match
    for (const m of matches) {
      expect(m.id).not.toContain("[[");
    }
  });

  test("handles sigil at start and end of string", () => {
    const matches = parseSigils("[[pr:1]]");
    expect(matches).toHaveLength(1);
    expect(matches[0].start).toBe(0);
    expect(matches[0].end).toBe(8);
  });

  test("handles URLs in id", () => {
    const matches = parseSigils("[[repo:Pizzaface/PizzaPi]]");
    expect(matches[0].id).toBe("Pizzaface/PizzaPi");
  });

  test("handles complex params mix", () => {
    const matches = parseSigils('[[check:typecheck conclusion=success repo="Foo/Bar"]]');
    expect(matches[0].type).toBe("check");
    expect(matches[0].id).toBe("typecheck");
    expect(matches[0].params).toEqual({ conclusion: "success", repo: "Foo/Bar" });
  });
});
