/**
 * Pure trigger-history grouping helpers — no React, no UI deps.
 *
 * Extracted from TriggersPanel.tsx so that the panel stays code-split
 * (React.lazy in App.tsx). slash-commands.ts and useTriggerCount.ts import
 * getIncompleteTriggers at runtime; if these helpers lived in the panel file,
 * the whole panel would be statically baked into the main entry chunk.
 */
import type { TriggerHistoryEntry } from "./trigger-utils";
import { isPendingTrigger } from "./trigger-utils";

export type { TriggerHistoryEntry } from "./trigger-utils";

/** A linked child session derived from trigger history. */
export interface LinkedSessionGroup {
  /** Session ID of the linked child */
  source: string;
  /** All trigger events from this session, most recent first */
  events: TriggerHistoryEntry[];
  /** The most recent pending trigger (no response), if any */
  pendingTrigger: TriggerHistoryEntry | null;
  /** Most recent trigger type */
  lastType: string;
  /** Most recent trigger timestamp */
  lastTs: string;
  /** Summary from the most recent trigger */
  lastSummary?: string;
}

/** Group triggers by linked session source. Returns groups sorted by most recent first. */
export function groupByLinkedSession(triggers: TriggerHistoryEntry[]): {
  sessionGroups: LinkedSessionGroup[];
  otherEvents: TriggerHistoryEntry[];
} {
  const groupMap = new Map<string, TriggerHistoryEntry[]>();
  const otherEvents: TriggerHistoryEntry[] = [];

  for (const t of triggers) {
    // Only group inbound triggers from non-external sources (child sessions)
    if (t.direction === "inbound" && t.source !== "api" && !t.source.startsWith("external:")) {
      const existing = groupMap.get(t.source);
      if (existing) {
        existing.push(t);
      } else {
        groupMap.set(t.source, [t]);
      }
    } else {
      otherEvents.push(t);
    }
  }

  const sessionGroups: LinkedSessionGroup[] = [];
  for (const [source, events] of groupMap) {
    // Events are already sorted most-recent-first from the API
    const pendingTrigger = events.find(isPendingTrigger) ?? null;
    sessionGroups.push({
      source,
      events,
      pendingTrigger,
      lastType: events[0].type,
      lastTs: events[0].ts,
      lastSummary: events[0].summary,
    });
  }

  // Sort: groups with pending triggers first, then by most recent event
  sessionGroups.sort((a, b) => {
    if (a.pendingTrigger && !b.pendingTrigger) return -1;
    if (!a.pendingTrigger && b.pendingTrigger) return 1;
    return new Date(b.lastTs).getTime() - new Date(a.lastTs).getTime();
  });

  return { sessionGroups, otherEvents };
}

// ── Incomplete trigger detection (used by /new warning) ────────────────────

export interface IncompleteTriggerItem {
  /** Display label (session name or ID) */
  label: string;
  /** What's incomplete */
  reason: string;
  /** Source session ID */
  source: string;
}

/**
 * Analyze trigger history and return a list of incomplete items.
 *
 * "Incomplete" means:
 * - A linked session with a pending interactive trigger (ask_user_question, plan_review, escalate)
 * - A linked session that is still active (no terminal session_complete, or a session_complete answered with followUp)
 *
 * Sessions that have sent session_complete are considered done once the child
 * actually stopped. A followUp response resumes the child, so it remains incomplete.
 */
export function getIncompleteTriggers(triggers: TriggerHistoryEntry[]): IncompleteTriggerItem[] {
  const { sessionGroups } = groupByLinkedSession(triggers);
  const items: IncompleteTriggerItem[] = [];

  for (const group of sessionGroups) {
    const label = group.lastSummary || group.source.slice(0, 12);

    // Has a pending interactive trigger (needs a response)
    if (group.pendingTrigger) {
      const type = group.pendingTrigger.type;
      // session_complete means the child is done — not truly "incomplete"
      if (type === "session_complete") continue;
      if (type === "ask_user_question") {
        items.push({ label, reason: "Waiting for your answer", source: group.source });
      } else if (type === "plan_review") {
        items.push({ label, reason: "Awaiting plan review", source: group.source });
      } else if (type === "escalate") {
        items.push({ label, reason: "Escalated — needs attention", source: group.source });
      } else {
        items.push({ label, reason: `Awaiting response to ${type}`, source: group.source });
      }
      continue;
    }

    // Events are most-recent-first; find() picks the newest session_complete
    const latestComplete = group.events.find((e) => e.type === "session_complete");
    if (latestComplete && latestComplete.response?.action !== "followUp") continue;

    // Still active (connected, no terminal session_complete)
    items.push({ label, reason: "Still running", source: group.source });
  }

  return items;
}