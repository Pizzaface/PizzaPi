export type SessionVisualState = "selected" | "awaiting" | "active" | "completedUnread" | "idle";

export interface SessionVisualStateInput {
  isSelected: boolean;
  isAwaiting: boolean;
  isActive: boolean;
  isCompletedUnread: boolean;
}

/**
 * Determine the visual state of a sidebar session row.
 * Priority: selected > awaiting > active > completedUnread > idle.
 */
export function getSessionVisualState(input: SessionVisualStateInput): SessionVisualState {
  if (input.isSelected) return "selected";
  if (input.isAwaiting) return "awaiting";
  if (input.isActive) return "active";
  if (input.isCompletedUnread) return "completedUnread";
  return "idle";
}
