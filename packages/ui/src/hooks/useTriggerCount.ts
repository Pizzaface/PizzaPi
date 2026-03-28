/**
 * useTriggerCount — lightweight hook that tracks the number of
 * incomplete triggers (active linked sessions, pending questions, etc.)
 * AND active trigger subscriptions for the badge on the Triggers button.
 *
 * Fetches on mount, on session change, and on trigger_delivered events.
 */
import { useState, useEffect, useCallback } from "react";
import { type TriggerHistoryEntry, getIncompleteTriggers } from "@/components/TriggersPanel";

export interface TriggerCounts {
  /** Incomplete triggers (pending questions, plans, etc.) */
  pending: number;
  /** Active trigger subscriptions (service subscriptions) */
  subscriptions: number;
  /** Total of both */
  total: number;
}

export function useTriggerCount(
  sessionId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewerSocket?: any,
): TriggerCounts {
  const [counts, setCounts] = useState<TriggerCounts>({ pending: 0, subscriptions: 0, total: 0 });

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setCounts({ pending: 0, subscriptions: 0, total: 0 });
      return;
    }
    try {
      const [trigRes, subRes] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`, { credentials: "include" }),
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`, { credentials: "include" }),
      ]);
      const pending = trigRes.ok
        ? getIncompleteTriggers(((await trigRes.json()) as { triggers: TriggerHistoryEntry[] }).triggers ?? []).length
        : 0;
      const subscriptions = subRes.ok
        ? ((await subRes.json()) as { subscriptions?: unknown[] }).subscriptions?.length ?? 0
        : 0;
      setCounts({ pending, subscriptions, total: pending + subscriptions });
    } catch {
      setCounts({ pending: 0, subscriptions: 0, total: 0 });
    }
  }, [sessionId]);

  // Fetch on mount and session change
  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh on trigger_delivered events
  useEffect(() => {
    if (!viewerSocket) return;
    const handler = () => { void refresh(); };
    viewerSocket.on("trigger_delivered", handler);
    return () => { viewerSocket.off("trigger_delivered", handler); };
  }, [viewerSocket, refresh]);

  return counts;
}
