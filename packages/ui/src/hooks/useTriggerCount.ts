/**
 * useTriggerCount — lightweight hook that tracks the number of
 * incomplete triggers (active linked sessions, pending questions, etc.)
 * AND active trigger subscriptions for the badge on the Triggers button.
 *
 * Fetches on mount, on session change, and on trigger_delivered events.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { getIncompleteTriggers, type TriggerHistoryEntry } from "@/attention/trigger-groups";

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
  /** Re-fetch both count sources, preserving each last-known value on failure. */
  refresh: () => Promise<void>;
}

export function useTriggerCount(
  sessionId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewerSocket?: any,
): TriggerCounts {
  const [counts, setCounts] = useState<Omit<TriggerCounts, "refresh">>({ pending: 0, subscriptions: 0, total: 0, latestTriggerKey: "" });

  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!sessionId) {
      setCounts({ pending: 0, subscriptions: 0, total: 0, latestTriggerKey: "" });
      return;
    }
    const refreshTriggers = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const triggerHistory = ((await res.json()) as { triggers?: TriggerHistoryEntry[] }).triggers ?? [];
        const pending = getIncompleteTriggers(triggerHistory).length;
        if (current === generation.current) {
          setCounts((previous) => ({
            ...previous,
            pending,
            total: pending + previous.subscriptions,
            latestTriggerKey: triggerHistory[0]?.triggerId ?? "",
          }));
        }
      } catch {
        // Keep the last-known trigger count when this source fails.
      }
    };

    const refreshRoutes = async () => {
      try {
        // Routes are the subscriptions (ADR-0002): count the session-target
        // routes for this session.
        const res = await fetch("/api/routes", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const routes = ((await res.json()) as { routes?: Array<{ target?: { kind?: string; sessionId?: string } }> }).routes ?? [];
        const subscriptions = routes.filter((r) => r.target?.kind === "session" && r.target.sessionId === sessionId).length;
        if (current === generation.current) {
          setCounts((previous) => ({
            ...previous,
            subscriptions,
            total: previous.pending + subscriptions,
          }));
        }
      } catch {
        // Keep the last-known route count when this source fails.
      }
    };

    await Promise.all([refreshTriggers(), refreshRoutes()]);
  }, [sessionId]);

  // Fetch on mount and session change
  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh on trigger_delivered events (route changes surface on the next
  // badge refresh — deltas are runner-scoped, not viewer-scoped).
  useEffect(() => {
    if (!viewerSocket) return;
    const handler = () => { void refresh(); };
    viewerSocket.on("trigger_delivered", handler);
    return () => {
      viewerSocket.off("trigger_delivered", handler);
    };
  }, [viewerSocket, refresh]);

  return { ...counts, refresh };
}
