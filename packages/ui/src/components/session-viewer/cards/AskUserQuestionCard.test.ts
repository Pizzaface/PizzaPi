import { describe, test, expect } from "bun:test";
import { parsePendingQuestions, formatAnswersForAgent } from "../../../lib/ask-user-questions";
import { extractRawAnswer, parseAnswerResult } from "../../../lib/ask-user-answer-parser";

// ── extractRawAnswer ────────────────────────────────────────────────

describe("extractRawAnswer", () => {
  test("returns null for null/undefined/empty", () => {
    expect(extractRawAnswer(null)).toBeNull();
    expect(extractRawAnswer("")).toBeNull();
    expect(extractRawAnswer("   ")).toBeNull();
  });

  test("strips 'User answered: ' prefix", () => {
    expect(extractRawAnswer("User answered: Red")).toBe("Red");
  });

  test("strips 'Answer received: ' prefix", () => {
    expect(extractRawAnswer("Answer received: Blue")).toBe("Blue");
  });

  test("strips prefix from multi-question JSON answer", () => {
    const json = JSON.stringify({ "Q1: Color?": "Blue", "Q2: Size?": "M" });
    expect(extractRawAnswer(`User answered: ${json}`)).toBe(json);
  });

  test("returns plain text when no prefix present", () => {
    expect(extractRawAnswer("Red")).toBe("Red");
  });

  test("returns null for 'User did not provide an answer.'", () => {
    expect(extractRawAnswer("User did not provide an answer.")).toBeNull();
  });

  test("returns null for pending prompt conflict", () => {
    expect(extractRawAnswer("A different AskUserQuestion prompt is already pending.")).toBeNull();
  });

  test("returns null for empty question error", () => {
    expect(extractRawAnswer("AskUserQuestion requires at least one non-empty question.")).toBeNull();
  });

  test("returns null for waiting status", () => {
    expect(extractRawAnswer("Waiting for answer: What color?")).toBeNull();
  });

  test("returns null when prefix present but body is empty", () => {
    expect(extractRawAnswer("User answered: ")).toBeNull();
    expect(extractRawAnswer("User answered:   ")).toBeNull();
  });
});

// ── parseAnswerResult ───────────────────────────────────────────────

describe("parseAnswerResult", () => {
  const singleQ = [{ question: "Color?", options: ["Red", "Blue"] }];
  const multiQ = [
    { question: "Color?", options: ["Red", "Blue"] },
    { question: "Size?", options: ["S", "M", "L"] },
  ];

  test("returns null for null/empty result", () => {
    expect(parseAnswerResult(null, singleQ)).toBeNull();
    expect(parseAnswerResult("", singleQ)).toBeNull();
  });

  test("returns null for empty questions array", () => {
    expect(parseAnswerResult("User answered: Red", [])).toBeNull();
  });

  test("returns null for cancellation text", () => {
    expect(parseAnswerResult("User did not provide an answer.", singleQ)).toBeNull();
  });

  test("returns null for waiting text", () => {
    expect(parseAnswerResult("Waiting for answer: Color?", singleQ)).toBeNull();
  });

  test("parses single-question plain text answer", () => {
    expect(parseAnswerResult("User answered: Red", singleQ)).toEqual([
      { question: "Color?", answer: "Red" },
    ]);
  });

  test("parses single-question answer without prefix", () => {
    expect(parseAnswerResult("Red", singleQ)).toEqual([
      { question: "Color?", answer: "Red" },
    ]);
  });

  test("parses multi-question JSON answer with prefix", () => {
    const json = JSON.stringify({ "Q1: Color?": "Blue", "Q2: Size?": "M" });
    expect(parseAnswerResult(`User answered: ${json}`, multiQ)).toEqual([
      { question: "Color?", answer: "Blue" },
      { question: "Size?", answer: "M" },
    ]);
  });

  test("parses multi-question JSON answer without prefix", () => {
    const json = JSON.stringify({ "Q1: Color?": "Blue", "Q2: Size?": "M" });
    expect(parseAnswerResult(json, multiQ)).toEqual([
      { question: "Color?", answer: "Blue" },
      { question: "Size?", answer: "M" },
    ]);
  });

  test("falls back to single answer if JSON parse fails for multi-Q", () => {
    expect(parseAnswerResult("User answered: just text", multiQ)).toEqual([
      { question: "Color?", answer: "just text" },
    ]);
  });
});

// ── Round-trip: formatAnswersForAgent → parseAnswerResult ───────────

describe("answer round-trip", () => {
  test("single question round-trips through format → prefix → parse", () => {
    const questions = parsePendingQuestions({
      questions: [{ question: "Color?", options: ["Red", "Blue"] }],
    });
    const formatted = formatAnswersForAgent([{ question: "Color?", answer: "Red" }]);
    const resultText = `User answered: ${formatted}`;
    const parsed = parseAnswerResult(resultText, questions);
    expect(parsed).toEqual([{ question: "Color?", answer: "Red" }]);
  });

  test("multi question round-trips through format → prefix → parse", () => {
    const questions = parsePendingQuestions({
      questions: [
        { question: "Color?", options: ["Red", "Blue"] },
        { question: "Size?", options: ["S", "M", "L"] },
      ],
    });
    const formatted = formatAnswersForAgent([
      { question: "Color?", answer: "Blue" },
      { question: "Size?", answer: "M" },
    ]);
    const resultText = `User answered: ${formatted}`;
    const parsed = parseAnswerResult(resultText, questions);
    expect(parsed).toEqual([
      { question: "Color?", answer: "Blue" },
      { question: "Size?", answer: "M" },
    ]);
  });
});
