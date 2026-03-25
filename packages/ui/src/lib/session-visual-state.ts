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
