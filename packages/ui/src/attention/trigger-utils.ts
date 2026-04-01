/**
 * Shared trigger utilities — types and helpers used by both the attention
 * normalizers and the TriggersPanel component.
 *
 * Kept separate so pure-logic modules (normalizers.ts) don't depend on
 * React component files.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface TriggerHistoryEntry {
  triggerId: string;
  type: string;
  source: string;
  summary?: string;
  payload: Record<string, unknown>;
  deliverAs: "steer" | "followUp";
  ts: string;
  direction: "inbound" | "outbound";
  response?: {
    action?: string;
    text?: string;
    ts: string;
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Known trigger types that require a response (interactive triggers). */
export const RESPONSE_TRIGGER_TYPES = new Set([
  "ask_user_question",
  "plan_review",
  "escalate",
]);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Whether a trigger is "pending" — inbound, requires response, and has none. */
export function isPendingTrigger(entry: TriggerHistoryEntry): boolean {
  if (entry.direction !== "inbound") return false;
  if (entry.response) return false;
  return RESPONSE_TRIGGER_TYPES.has(entry.type);
}
