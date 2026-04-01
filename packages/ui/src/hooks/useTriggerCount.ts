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
  /**
   * The triggerId of the most recent entry in trigger history (index 0).
   * Used as a dep signal in useAttentionIngestion so that any new inbound
   * trigger (even non-pending ones) causes the Action Center to re-ingest.
   * Using the ID rather than array length means the effect re-runs even when
   * the history is saturated at the fetch limit (50) and one old event is
   * evicted for every new one (length stays constant but this key changes).
   */
  latestTriggerKey: string;
}

export function useTriggerCount(
  sessionId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewerSocket?: any,
): TriggerCounts {
  const [counts, setCounts] = useState<TriggerCounts>({ pending: 0, subscriptions: 0, total: 0, latestTriggerKey: "" });

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setCounts({ pending: 0, subscriptions: 0, total: 0, latestTriggerKey: "" });
      return;
    }
    try {
      const [trigRes, subRes] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`, { credentials: "include" }),
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`, { credentials: "include" }),
      ]);
      const triggerHistory = trigRes.ok
        ? ((await trigRes.json()) as { triggers: TriggerHistoryEntry[] }).triggers ?? []
        : [];
      const pending = getIncompleteTriggers(triggerHistory).length;
      const subscriptions = subRes.ok
        ? ((await subRes.json()) as { subscriptions?: unknown[] }).subscriptions?.length ?? 0
        : 0;
      setCounts({ pending, subscriptions, total: pending + subscriptions, latestTriggerKey: triggerHistory[0]?.triggerId ?? "" });
    } catch {
      setCounts({ pending: 0, subscriptions: 0, total: 0, latestTriggerKey: "" });
    }
  }, [sessionId]);

  // Fetch on mount and session change
  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh on trigger_delivered and trigger_subscriptions_changed events
  useEffect(() => {
    if (!viewerSocket) return;
    const handler = () => { void refresh(); };
    viewerSocket.on("trigger_delivered", handler);
    viewerSocket.on("trigger_subscriptions_changed", handler);
    return () => {
      viewerSocket.off("trigger_delivered", handler);
      viewerSocket.off("trigger_subscriptions_changed", handler);
    };
  }, [viewerSocket, refresh]);

  return counts;
}
