/**
 * Attention system types.
 *
 * The attention system provides a single, normalized model for "what needs
 * the user's attention right now" — replacing scattered state across App.tsx,
 * SessionViewer, SessionSidebar, and TriggersPanel.
 */

/** High-level urgency bucket. Determines visual treatment + sort order. */
export type AttentionCategory = "needs_response" | "running" | "completed" | "info";

/** Specific kind of attention item — determines icon + description. */
export type AttentionItemKind =
  | "question"
  | "plan_review"
  | "trigger_response"
  | "plugin_trust"
  | "oauth"
  | "compacting"
  | "child_running"
  | "agent_active"
  | "session_complete";

export interface AttentionItem {
  /** Stable unique ID — used for deduplication and updates. */
  id: string;
  /** Which urgency bucket this item belongs to. */
  category: AttentionCategory;
  /** What kind of item this is. */
  kind: AttentionItemKind;
  /** Session this item is associated with. */
  sessionId: string;
  /** Human-readable session name, if known. */
  sessionName?: string;
  /** ISO timestamp when this item was created / first seen. */
  createdAt: string;
  /**
   * Sort priority within a category. Lower = more urgent.
   * Default: 50. Questions/plans = 10, escalations = 5.
   */
  priority: number;
  /** Where this item was derived from. */
  source: "meta" | "trigger" | "local";
  /** Arbitrary extra data for rendering / actions. */
  payload?: unknown;
}

/** The full attention store state — a normalized map keyed by item ID. */
export interface AttentionStoreState {
  items: Map<string, AttentionItem>;
  /** Monotonically increasing version counter — bumped on every mutation. */
  version: number;
}
