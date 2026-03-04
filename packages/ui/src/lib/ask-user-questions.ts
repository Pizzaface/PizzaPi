/**
 * Shared utilities for AskUserQuestion data parsing.
 */

export interface ParsedQuestion {
  question: string;
  options: string[];
}

/**
 * Parse pending question data from heartbeat / tool_execution events.
 * Supports the canonical `{ questions: [...] }` shape and the legacy
 * `{ question, options }` shape (for older CLI workers).
 */
export function parsePendingQuestions(data: Record<string, unknown> | undefined | null): ParsedQuestion[] {
  if (!data) return [];

  // New format: questions[]
  if (Array.isArray(data.questions)) {
    const result: ParsedQuestion[] = [];
    for (const q of data.questions) {
      if (q && typeof q === "object" && typeof (q as any).question === "string" && (q as any).question.trim()) {
        const opts = Array.isArray((q as any).options)
          ? ((q as any).options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
          : [];
        result.push({ question: (q as any).question.trim(), options: opts });
      }
    }
    if (result.length > 0) return result;
  }

  // Legacy format: { question, options }
  if (typeof data.question === "string" && data.question.trim()) {
    const opts = Array.isArray(data.options)
      ? (data.options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
      : [];
    return [{ question: (data.question as string).trim(), options: opts }];
  }

  return [];
}

/**
 * Format MultipleChoiceAnswers into a string for sending to the agent.
 * Single question → plain text. Multiple → JSON with indexed keys.
 */
export function formatAnswersForAgent(
  answers: Array<{ question: string; answer: string }>,
): string {
  if (answers.length === 1) return answers[0].answer;
  return JSON.stringify(
    Object.fromEntries(answers.map((a, i) => [`Q${i + 1}: ${a.question}`, a.answer])),
  );
}
