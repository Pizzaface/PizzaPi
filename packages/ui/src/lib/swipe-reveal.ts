/**
 * SessionSidebar swipe-to-reveal stores per-session offsets in a Map.
 *
 * UX-wise we only want ONE session to be in a revealed/dragged state at a time.
 * This helper prunes the map down to a single entry (or none).
 */
export function pruneSwipeOffsets(
  offsets: Map<string, number>,
  keepSessionId: string | null,
): Map<string, number> {
  if (!keepSessionId) return new Map();
  if (!offsets.has(keepSessionId)) return new Map();

  return new Map([[keepSessionId, offsets.get(keepSessionId)!]]);
}
