export type SessionVisualState = "selected" | "selectedActive" | "awaiting" | "active" | "completedUnread" | "idle";

export interface SessionVisualStateInput {
  isSelected: boolean;
  isAwaiting: boolean;
  isActive: boolean;
  isCompletedUnread: boolean;
  /** Session is compacting its context — treated as "active" for visual purposes. */
  isCompacting?: boolean;
}

/**
 * Determine the visual state of a sidebar session row.
 * Priority: selected (+ active variant) > awaiting > active > completedUnread > idle.
 *
 * Compacting is treated as active: the agent is doing internal work (context
 * compaction) even though the heartbeat reports `active: false`.
 */
export function getSessionVisualState(input: SessionVisualStateInput): SessionVisualState {
  const effectivelyActive = input.isActive || !!input.isCompacting;
  if (input.isSelected && effectivelyActive) return "selectedActive";
  if (input.isSelected) return "selected";
  if (input.isAwaiting) return "awaiting";
  if (effectivelyActive) return "active";
  if (input.isCompletedUnread) return "completedUnread";
  return "idle";
}

export interface SessionStatusCounts {
  awaiting: number;
  working: number;
  completed: number;
}

/** Count sessions by status for group chips. Awaiting > working > completed(unread); selection is ignored. */
export function countSessionStatuses(
  sessions: ReadonlyArray<{ sessionId: string; isActive?: boolean }>,
  awaiting: ReadonlySet<string> | undefined,
  compacting: ReadonlySet<string> | undefined,
  completedUnread: ReadonlySet<string>,
): SessionStatusCounts {
  const counts = { awaiting: 0, working: 0, completed: 0 };
  for (const s of sessions) {
    if (awaiting?.has(s.sessionId)) counts.awaiting++;
    else if (s.isActive || compacting?.has(s.sessionId)) counts.working++;
    else if (completedUnread.has(s.sessionId)) counts.completed++;
  }
  return counts;
}
