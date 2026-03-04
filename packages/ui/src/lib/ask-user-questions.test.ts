import { describe, test, expect } from "bun:test";
import { parsePendingQuestions, formatAnswersForAgent } from "./ask-user-questions";

describe("parsePendingQuestions", () => {
  test("returns empty for null/undefined", () => {
    expect(parsePendingQuestions(null)).toEqual([]);
    expect(parsePendingQuestions(undefined)).toEqual([]);
  });

  test("returns empty for empty object", () => {
    expect(parsePendingQuestions({})).toEqual([]);
  });

  test("returns empty when questions is not an array", () => {
    expect(parsePendingQuestions({ questions: "not-array" })).toEqual([]);
  });

  // ── New format ────────────────────────────────────────────────────────

  test("parses multi-question format", () => {
    const result = parsePendingQuestions({
      questions: [
        { question: "Color?", options: ["Red", "Blue"] },
        { question: "Size?", options: ["S", "M", "L"] },
      ],
    });
    expect(result).toEqual([
      { question: "Color?", options: ["Red", "Blue"] },
      { question: "Size?", options: ["S", "M", "L"] },
    ]);
  });

  test("parses single question in array", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Ready?", options: ["Yes", "No"] }],
    });
    expect(result).toEqual([{ question: "Ready?", options: ["Yes", "No"] }]);
  });

  test("trims whitespace from questions", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "  Padded?  ", options: ["Yes"] }],
    });
    expect(result).toEqual([{ question: "Padded?", options: ["Yes"] }]);
  });

  test("filters out non-string options", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Pick", options: ["A", 42, null, "B"] }],
    });
    expect(result).toEqual([{ question: "Pick", options: ["A", "B"] }]);
  });

  test("skips questions with empty text", () => {
    const result = parsePendingQuestions({
      questions: [
        { question: "", options: ["A"] },
        { question: "Valid?", options: ["Yes"] },
      ],
    });
    expect(result).toEqual([{ question: "Valid?", options: ["Yes"] }]);
  });

  test("handles missing options in questions array items", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "No opts?" }],
    });
    expect(result).toEqual([{ question: "No opts?", options: [] }]);
  });

  test("returns empty for empty questions array", () => {
    expect(parsePendingQuestions({ questions: [] })).toEqual([]);
  });

  test("skips non-object entries in questions array", () => {
    const result = parsePendingQuestions({
      questions: [null, "string", 42, { question: "Valid?", options: ["Yes"] }],
    });
    expect(result).toEqual([{ question: "Valid?", options: ["Yes"] }]);
  });

  // ── Legacy format (backward compat) ──────────────────────────────────

  test("parses legacy single-question format", () => {
    const result = parsePendingQuestions({
      question: "What color?",
      options: ["Red", "Blue", "Green"],
    });
    expect(result).toEqual([
      { question: "What color?", options: ["Red", "Blue", "Green"] },
    ]);
  });

  test("handles legacy format with no options", () => {
    const result = parsePendingQuestions({
      question: "What do you think?",
    });
    expect(result).toEqual([
      { question: "What do you think?", options: [] },
    ]);
  });

  test("prefers new format over legacy when both present", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "New format", options: ["A"] }],
      question: "Old format",
      options: ["B"],
    });
    expect(result).toEqual([{ question: "New format", options: ["A"] }]);
  });

  test("falls back to legacy when questions array is empty", () => {
    const result = parsePendingQuestions({
      questions: [],
      question: "Fallback?",
      options: ["Yes"],
    });
    expect(result).toEqual([{ question: "Fallback?", options: ["Yes"] }]);
  });

  test("ignores legacy format with blank question", () => {
    expect(parsePendingQuestions({ question: "  ", options: ["A"] })).toEqual([]);
  });
});

describe("formatAnswersForAgent", () => {
  test("single question returns plain text answer", () => {
    expect(formatAnswersForAgent([
      { question: "Color?", answer: "Red" },
    ])).toBe("Red");
  });

  test("multiple questions returns JSON with indexed keys", () => {
    const result = formatAnswersForAgent([
      { question: "Color?", answer: "Blue" },
      { question: "Size?", answer: "Large" },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      "Q1: Color?": "Blue",
      "Q2: Size?": "Large",
    });
  });

  test("multiple questions with same question text get unique indexed keys", () => {
    const result = formatAnswersForAgent([
      { question: "Pick one", answer: "A" },
      { question: "Pick one", answer: "B" },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      "Q1: Pick one": "A",
      "Q2: Pick one": "B",
    });
  });

  test("handles custom written answers", () => {
    const result = formatAnswersForAgent([
      { question: "Color?", answer: "Red" },
      { question: "Other?", answer: "My custom text" },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed["Q2: Other?"]).toBe("My custom text");
  });
});
