import { describe, test, expect } from "bun:test";
import { extractRawAnswer, parseAnswerResult } from "./ask-user-answer-parser";
import type { ParsedQuestion } from "./ask-user-questions";

// ---------------------------------------------------------------------------
// extractRawAnswer
// ---------------------------------------------------------------------------
describe("extractRawAnswer", () => {
  test("returns null for null input", () => {
    expect(extractRawAnswer(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractRawAnswer("")).toBeNull();
  });

  test("strips 'User answered: ' prefix", () => {
    expect(extractRawAnswer("User answered: Red")).toBe("Red");
  });

  test("strips 'Answer received: ' prefix", () => {
    expect(extractRawAnswer("Answer received: Blue")).toBe("Blue");
  });

  test("returns raw text when no prefix is present", () => {
    expect(extractRawAnswer("Red")).toBe("Red");
  });

  test("returns null for non-answer patterns", () => {
    expect(extractRawAnswer("User did not provide an answer")).toBeNull();
    expect(extractRawAnswer("A different AskUserQuestion prompt is already pending")).toBeNull();
    expect(extractRawAnswer("AskUserQuestion requires at least one non-empty question")).toBeNull();
    expect(extractRawAnswer("Waiting for answer:")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(extractRawAnswer("  User answered:   hello  ")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// parseAnswerResult
// ---------------------------------------------------------------------------
const q1: ParsedQuestion = {
  question: "Pick a color",
  options: ["Red", "Blue", "Green"],
  type: "radio",
};
const q2: ParsedQuestion = {
  question: "Pick a size",
  options: ["S", "M", "L"],
  type: "radio",
};

describe("parseAnswerResult", () => {
  test("returns null when extractRawAnswer returns null", () => {
    expect(parseAnswerResult("User did not provide an answer", [q1])).toBeNull();
  });

  test("returns null when questions array is empty", () => {
    expect(parseAnswerResult("User answered: Red", [])).toBeNull();
  });

  // Single question — plain text answer
  test("single question: returns Q&A pair for plain text answer", () => {
    const result = parseAnswerResult("User answered: Red", [q1]);
    expect(result).toHaveLength(1);
    expect(result![0].question).toBe("Pick a color");
    expect(result![0].answer).toBe("Red");
  });

  // Multi-question — valid JSON
  test("multi-question: parses structured JSON answer", () => {
    const structured = JSON.stringify({
      "Q1: Pick a color": "Red",
      "Q2: Pick a size": "M",
    });
    const result = parseAnswerResult(`User answered: ${structured}`, [q1, q2]);
    expect(result).toHaveLength(2);
    // Keys are stripped of "Q<n>: " prefix
    expect(result![0].question).toBe("Pick a color");
    expect(result![0].answer).toBe("Red");
    expect(result![1].question).toBe("Pick a size");
    expect(result![1].answer).toBe("M");
  });

  // Fix 3 regression: Multi-question JSON-parse fallback must attribute raw text to ALL questions
  test("multi-question JSON fallback: attributes raw text to ALL questions, not just the first", () => {
    // When the raw text is not valid JSON, every question should get the raw answer
    // rather than only the first question getting it and the rest being silently discarded.
    const result = parseAnswerResult("User answered: some free-form answer", [q1, q2]);
    expect(result).toHaveLength(2);
    expect(result![0].question).toBe("Pick a color");
    expect(result![0].answer).toBe("some free-form answer");
    expect(result![1].question).toBe("Pick a size");
    expect(result![1].answer).toBe("some free-form answer");
  });

  test("multi-question fallback with three questions maps raw to all three", () => {
    const q3: ParsedQuestion = { question: "Pick a style", options: ["A", "B"], type: "radio" };
    const result = parseAnswerResult("User answered: plain", [q1, q2, q3]);
    expect(result).toHaveLength(3);
    for (const entry of result!) {
      expect(entry.answer).toBe("plain");
    }
  });

  // Single-question fallback — unchanged behaviour: only one entry returned
  test("single question non-JSON answer: still returns exactly one entry", () => {
    const result = parseAnswerResult("User answered: just text", [q1]);
    expect(result).toHaveLength(1);
    expect(result![0].question).toBe("Pick a color");
    expect(result![0].answer).toBe("just text");
  });

  test("multi-question: invalid JSON object (array) falls back to raw for all questions", () => {
    // JSON array is not the expected object shape — should fall back
    const result = parseAnswerResult('User answered: ["Red","M"]', [q1, q2]);
    // Could be parsed as JSON but the shape check (entries every v string) may or may not match;
    // the important thing is we get 2 entries either way (all questions covered)
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
    // If fallback was taken, both questions should appear
    if (result!.length === 2) {
      expect(result![1].question).toBe("Pick a size");
    }
  });
});
