import { describe, test, expect } from "bun:test";

// Since we can't easily render React components in Bun tests without a DOM,
// we test the core logic that the component relies on.

// Re-implement the parsePendingQuestions logic for testing (mirrors App.tsx)
function parsePendingQuestions(data: Record<string, unknown> | undefined | null): Array<{ question: string; options: string[] }> {
  if (!data) return [];
  if (Array.isArray(data.questions)) {
    const result: Array<{ question: string; options: string[] }> = [];
    for (const q of data.questions) {
      if (q && typeof q === "object" && typeof (q as any).question === "string" && (q as any).question.trim()) {
        const opts = Array.isArray((q as any).options)
          ? ((q as any).options as unknown[]).filter((o): o is string => typeof o === "string")
          : [];
        result.push({ question: (q as any).question.trim(), options: opts });
      }
    }
    if (result.length > 0) return result;
  }
  if (typeof data.question === "string" && data.question.trim()) {
    const opts = Array.isArray(data.options)
      ? (data.options as unknown[]).filter((o): o is string => typeof o === "string")
      : [];
    return [{ question: (data.question as string).trim(), options: opts }];
  }
  return [];
}

describe("parsePendingQuestions", () => {
  test("returns empty for null/undefined", () => {
    expect(parsePendingQuestions(null)).toEqual([]);
    expect(parsePendingQuestions(undefined)).toEqual([]);
  });

  test("returns empty for empty object", () => {
    expect(parsePendingQuestions({})).toEqual([]);
  });

  test("parses new multi-question format", () => {
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

  test("parses single question in new format", () => {
    const result = parsePendingQuestions({
      questions: [{ question: "Ready?", options: ["Yes", "No"] }],
    });
    expect(result).toEqual([{ question: "Ready?", options: ["Yes", "No"] }]);
  });

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
});

describe("MultipleChoiceQuestions answer formatting", () => {
  // Test the answer format logic that the component uses
  function formatAnswers(
    questions: Array<{ question: string; options: string[] }>,
    selections: Map<number, number>,
    customTexts: Map<number, string>,
  ): string {
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const sel = selections.get(i)!;
      answers[q.question] = sel === q.options.length
        ? (customTexts.get(i) ?? "").trim()
        : q.options[sel];
    }
    const keys = Object.keys(answers);
    return keys.length === 1
      ? answers[keys[0]]
      : JSON.stringify(answers);
  }

  test("single question returns plain text answer", () => {
    const questions = [{ question: "Color?", options: ["Red", "Blue"] }];
    const selections = new Map([[0, 0]]);
    expect(formatAnswers(questions, selections, new Map())).toBe("Red");
  });

  test("single question with custom text", () => {
    const questions = [{ question: "Color?", options: ["Red", "Blue"] }];
    const selections = new Map([[0, 2]]); // index 2 = "Write your own…"
    const customTexts = new Map([[0, "Purple"]]);
    expect(formatAnswers(questions, selections, customTexts)).toBe("Purple");
  });

  test("multiple questions returns JSON", () => {
    const questions = [
      { question: "Color?", options: ["Red", "Blue"] },
      { question: "Size?", options: ["S", "M", "L"] },
    ];
    const selections = new Map([[0, 1], [1, 2]]);
    const result = formatAnswers(questions, selections, new Map());
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ "Color?": "Blue", "Size?": "L" });
  });

  test("multiple questions with mixed selections and custom text", () => {
    const questions = [
      { question: "Color?", options: ["Red", "Blue"] },
      { question: "Size?", options: ["S", "M"] },
    ];
    const selections = new Map([[0, 0], [1, 2]]); // Q2: "Write your own…"
    const customTexts = new Map([[1, "XL"]]);
    const result = formatAnswers(questions, selections, customTexts);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ "Color?": "Red", "Size?": "XL" });
  });
});
