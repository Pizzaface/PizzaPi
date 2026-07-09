import type { QueuedMessage } from "./types";

/**
 * Reconcile the local queued-message list against the authoritative
 * follow-up texts reported by the runner (heartbeat / session snapshot).
 *
 * - Reuses existing entry ids where texts match, so React keys and any
 *   in-flight edit state stay stable across syncs.
 * - Returns `prev` (same reference) when nothing changed, so callers can
 *   skip re-renders and cache patches on every heartbeat.
 */
export function reconcileMessageQueue(prev: QueuedMessage[], followUpTexts: string[]): QueuedMessage[] {
  const unchanged =
    prev.length === followUpTexts.length &&
    prev.every((qm, i) => qm.text === followUpTexts[i] && qm.deliverAs === "followUp");
  if (unchanged) return prev;

  const pool = [...prev];
  return followUpTexts.map((text) => {
    const idx = pool.findIndex((qm) => qm.text === text && qm.deliverAs === "followUp");
    if (idx !== -1) return pool.splice(idx, 1)[0];
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      deliverAs: "followUp" as const,
      timestamp: Date.now(),
    };
  });
}

/**
 * Pick the queued-message id to recall when the user presses Up/Down to browse
 * the queue (shell-history style).
 *
 * - `currentId === null` means focus is in the composer: Up recalls the newest
 *   queued message, Down does nothing.
 * - From a queued message: Up steps to the previous (older) one, Down to the
 *   next (newer). Past the newest, Down returns `null` (exit back to composer);
 *   at the oldest, Up returns `null` (stay put).
 */
export function queueRecallTarget(
  queue: QueuedMessage[],
  currentId: string | null,
  dir: "up" | "down",
): string | null {
  if (queue.length === 0) return null;
  const idx = currentId === null ? queue.length : queue.findIndex((m) => m.id === currentId);
  const target = dir === "up" ? idx - 1 : idx + 1;
  return target >= 0 && target < queue.length ? queue[target].id : null;
}
