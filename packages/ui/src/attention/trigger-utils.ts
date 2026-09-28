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

const KNOWN_LIFECYCLE_TYPES = new Set([
  ...RESPONSE_TRIGGER_TYPES,
  "session_complete",
  "session_connect",
  "session_linked",
  "session_error",
  "session_end",
]);

/** Strip the lifecycle service prefix only for known lifecycle event names. */
export function normalizeTriggerType(type: string): string {
  if (type === "lifecycle:ask_question") return "ask_user_question";
  if (type === "lifecycle:escalation") return "escalate";
  if (KNOWN_LIFECYCLE_TYPES.has(type)) return type;
  const prefix = "lifecycle:";
  const unprefixed = type.startsWith(prefix) ? type.slice(prefix.length) : "";
  return KNOWN_LIFECYCLE_TYPES.has(unprefixed) ? unprefixed : type;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Whether a trigger is "pending" — inbound, requires response, and has none. */
export function isPendingTrigger(entry: TriggerHistoryEntry): boolean {
  if (entry.direction !== "inbound") return false;
  if (entry.response) return false;
  return RESPONSE_TRIGGER_TYPES.has(normalizeTriggerType(entry.type));
}
