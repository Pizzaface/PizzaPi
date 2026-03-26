/**
 * Pure-logic utilities for parsing AskUserQuestion tool results.
 * Separated from the React component so they can be unit-tested without DOM deps.
 */

import type { ParsedQuestion } from "./ask-user-questions";

/** Prefixes emitted by the CLI tool before the raw answer text. */
const ANSWER_PREFIXES = ["User answered: ", "Answer received: "] as const;

/** Result texts that indicate no answer was provided (cancellation / error). */
const NON_ANSWER_PATTERNS = [
  "User did not provide an answer",
  "A different AskUserQuestion prompt is already pending",
  "AskUserQuestion requires at least one non-empty question",
  "Waiting for answer:",
] as const;

/**
 * Extract the raw answer text from the tool result.
 * Strips known prefixes (e.g. "User answered: ...") and returns null
 * for cancellation / error / waiting messages.
 */
export function extractRawAnswer(resultText: string | null): string | null {
  if (!resultText) return null;
  const trimmed = resultText.trim();
  if (!trimmed) return null;

  // Reject non-answer outputs
  const lower = trimmed.toLowerCase();
  for (const pattern of NON_ANSWER_PATTERNS) {
    if (lower.startsWith(pattern.toLowerCase())) return null;
  }

  // Strip known prefixes (also match without trailing space for edge cases
  // where the answer was empty and .trim() collapsed the separator)
  for (const prefix of ANSWER_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const body = trimmed.slice(prefix.length).trim();
      return body || null;
    }
    const stripped = prefix.trimEnd();
    if (trimmed === stripped || trimmed.startsWith(stripped + "\n")) {
      return null; // prefix present but no answer body
    }
  }

  // No prefix — treat the whole string as the answer (e.g. plain "Red")
  return trimmed;
}

/**
 * Parse the user's answer text back into a structured Q&A list.
 * Handles both single-question plain text and multi-question JSON
 * (keyed as `"Q1: question text": "answer"`).
 */
export function parseAnswerResult(
  resultText: string | null,
  questions: ParsedQuestion[],
): Array<{ question: string; answer: string }> | null {
  const raw = extractRawAnswer(resultText);
  if (!raw) return null;
  if (questions.length === 0) return null;

  // Multi-question — try JSON parse
  if (questions.length > 1) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.length > 0 && entries.every(([, v]) => typeof v === "string")) {
          return entries.map(([key, v]) => ({
            question: key.replace(/^Q\d+:\s*/, ""),
            answer: v as string,
          }));
        }
      }
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Single question: return just that one.
  // Multi-question JSON-parse fallback: attribute the raw text to ALL questions so
  // none are silently discarded when the structured JSON wasn't available.
  return questions.map((q) => ({ question: q.question, answer: raw }));
}
