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
