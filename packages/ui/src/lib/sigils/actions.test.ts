import { describe, expect, test } from "bun:test";
import { buildActionResponse, parseActionOptions, parseActionSigil } from "./actions";

describe("parseActionSigil", () => {
  test("parses confirm with required question", () => {
    expect(parseActionSigil("confirm", { question: "Deploy to production?" })).toEqual({
      ok: true,
      action: { kind: "confirm", question: "Deploy to production?" },
    });
  });

  test("parses choose options", () => {
    expect(parseActionSigil("choose", {
      question: "Merge strategy?",
      options: "merge,rebase,squash",
    })).toEqual({
      ok: true,
      action: { kind: "choose", question: "Merge strategy?", options: ["merge", "rebase", "squash"] },
    });
  });

  test("choose drops empty options and rejects all-empty input", () => {
    expect(parseActionOptions("merge, ,squash ,, ")).toEqual(["merge", "squash"]);
    expect(parseActionSigil("choose", {
      question: "Merge strategy?",
      options: "  , , ",
    })).toEqual({ ok: false, error: "missing_options" });
  });

  test("parses input with optional placeholder", () => {
    expect(parseActionSigil("input", {
      question: "Branch name?",
      placeholder: "feat/...",
    })).toEqual({
      ok: true,
      action: { kind: "input", question: "Branch name?", placeholder: "feat/..." },
    });
  });

  test("rejects unknown variant", () => {
    expect(parseActionSigil("wat", { question: "Hi?" })).toEqual({ ok: false, error: "unknown_variant" });
  });

  test("rejects missing question", () => {
    expect(parseActionSigil("confirm", {})).toEqual({ ok: false, error: "missing_question" });
  });

  test("formats confirm and cancel responses", () => {
    const parsed = parseActionSigil("confirm", { question: "Deploy to production?" });
    if (!parsed.ok) throw new Error("expected parsed action");
    expect(buildActionResponse(parsed.action, "confirm")).toBe([
      "Action sigil response",
      "variant=confirm",
      "question=Deploy to production?",
      "value=confirm",
    ].join("\n"));
    expect(buildActionResponse(parsed.action, "cancel")).toBe([
      "Action sigil response",
      "variant=confirm",
      "question=Deploy to production?",
      "value=cancel",
    ].join("\n"));
  });

  test("formats input values with punctuation safely as multiline text", () => {
    const parsed = parseActionSigil("input", { question: "Branch name?" });
    if (!parsed.ok) throw new Error("expected parsed action");
    expect(buildActionResponse(parsed.action, "feat/a|b=c")).toBe([
      "Action sigil response",
      "variant=input",
      "question=Branch name?",
      "value=feat/a|b=c",
    ].join("\n"));
  });
});
