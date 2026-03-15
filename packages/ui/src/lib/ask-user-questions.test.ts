import { describe, test, expect } from "bun:test";
import { parsePendingQuestionDisplayMode, parsePendingQuestions, formatAnswersForAgent } from "./ask-user-questions";

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
      { question: "Color?", options: ["Red", "Blue"], type: "radio" },
      { question: "Size?", options: ["S", "M", "L"], type: "radio" },
    ]);
  });

  test("parses single question in array", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Ready?", options: ["Yes", "No"] }],
    });
    expect(result).toEqual([{ question: "Ready?", options: ["Yes", "No"], type: "radio" }]);
  });

  test("trims whitespace from questions", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "  Padded?  ", options: ["Yes"] }],
    });
    expect(result).toEqual([{ question: "Padded?", options: ["Yes"], type: "radio" }]);
  });

  test("filters out non-string options", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Pick", options: ["A", 42, null, "B"] }],
    });
    expect(result).toEqual([{ question: "Pick", options: ["A", "B"], type: "radio" }]);
  });

  test("trims options and filters empty/whitespace options", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Pick", options: ["  A  ", "", "  ", "B"] }],
    });
    expect(result).toEqual([{ question: "Pick", options: ["A", "B"], type: "radio" }]);
  });

  test("skips questions with empty text", () => {
    const result = parsePendingQuestions({
      questions: [
        { question: "", options: ["A"] },
        { question: "Valid?", options: ["Yes"] },
      ],
    });
    expect(result).toEqual([{ question: "Valid?", options: ["Yes"], type: "radio" }]);
  });

  test("handles missing options in questions array items", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "No opts?" }],
    });
    expect(result).toEqual([{ question: "No opts?", options: [], type: "radio" }]);
  });

  test("returns empty for empty questions array", () => {
    expect(parsePendingQuestions({ questions: [] })).toEqual([]);
  });

  test("skips non-object entries in questions array", () => {
    const result = parsePendingQuestions({
      questions: [null, "string", 42, { question: "Valid?", options: ["Yes"] }],
    });
    expect(result).toEqual([{ question: "Valid?", options: ["Yes"], type: "radio" }]);
  });

  // ── Question types ───────────────────────────────────────────────────

  test("parses checkbox question type", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Select all", options: ["A", "B", "C"], type: "checkbox" }],
    });
    expect(result).toEqual([{ question: "Select all", options: ["A", "B", "C"], type: "checkbox" }]);
  });

  test("parses ranked question type", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Rank these", options: ["X", "Y", "Z"], type: "ranked" }],
    });
    expect(result).toEqual([{ question: "Rank these", options: ["X", "Y", "Z"], type: "ranked" }]);
  });

  test("defaults unknown type to radio", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Pick", options: ["A"], type: "unknown_type" }],
    });
    expect(result).toEqual([{ question: "Pick", options: ["A"], type: "radio" }]);
  });

  test("mixed question types", () => {
    const result = parsePendingQuestions({
      questions: [
        { question: "Pick one", options: ["A", "B"], type: "radio" },
        { question: "Pick many", options: ["X", "Y"], type: "checkbox" },
        { question: "Rank them", options: ["1", "2", "3"], type: "ranked" },
      ],
    });
    expect(result).toEqual([
      { question: "Pick one", options: ["A", "B"], type: "radio" },
      { question: "Pick many", options: ["X", "Y"], type: "checkbox" },
      { question: "Rank them", options: ["1", "2", "3"], type: "ranked" },
    ]);
  });

  // ── Legacy format (backward compat) ──────────────────────────────────

  test("parses legacy single-question format", () => {
    const result = parsePendingQuestions({
      question: "What color?",
      options: ["Red", "Blue", "Green"],
    });
    expect(result).toEqual([
      { question: "What color?", options: ["Red", "Blue", "Green"], type: "radio" },
    ]);
  });

  test("handles legacy format with no options", () => {
    const result = parsePendingQuestions({
      question: "What do you think?",
    });
    expect(result).toEqual([
      { question: "What do you think?", options: [], type: "radio" },
    ]);
  });

  test("prefers new format over legacy when both present", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "New format", options: ["A"] }],
      question: "Old format",
      options: ["B"],
    });
    expect(result).toEqual([{ question: "New format", options: ["A"], type: "radio" }]);
  });

  test("falls back to legacy when questions array is empty", () => {
    const result = parsePendingQuestions({
      questions: [],
      question: "Fallback?",
      options: ["Yes"],
    });
    expect(result).toEqual([{ question: "Fallback?", options: ["Yes"], type: "radio" }]);
  });

  test("ignores legacy format with blank question", () => {
    expect(parsePendingQuestions({ question: "  ", options: ["A"] })).toEqual([]);
  });
});

describe("parsePendingQuestionDisplayMode", () => {
  test("returns stepper for explicit stepper", () => {
    expect(parsePendingQuestionDisplayMode({ display: "stepper" }, 3)).toBe("stepper");
  });

  test("forces stepper even when stacked is requested", () => {
    expect(parsePendingQuestionDisplayMode({ display: "stacked" }, 3)).toBe("stepper");
  });

  test("defaults to stepper for multi-question prompts", () => {
    expect(parsePendingQuestionDisplayMode({}, 2)).toBe("stepper");
  });

  test("defaults to stepper for single-question prompts", () => {
    expect(parsePendingQuestionDisplayMode({}, 1)).toBe("stepper");
  });

  test("ignores invalid display values", () => {
    expect(parsePendingQuestionDisplayMode({ display: "grid" }, 2)).toBe("stepper");
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
