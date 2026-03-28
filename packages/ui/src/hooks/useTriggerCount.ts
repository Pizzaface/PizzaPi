/**
 * useTriggerCount — lightweight hook that tracks the number of
 * incomplete triggers (active linked sessions, pending questions, etc.)
 * for the badge on the Triggers button.
 *
 * Fetches on mount, on session change, and on trigger_delivered events.
 */
import { useState, useEffect, useCallback } from "react";
import { type TriggerHistoryEntry, getIncompleteTriggers } from "@/components/TriggersPanel";

export function useTriggerCount(
  sessionId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewerSocket?: any,
): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setCount(0);
      return;
    }
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`,
        { credentials: "include" },
      );
      if (!res.ok) { setCount(0); return; }
      const data = await res.json() as { triggers: TriggerHistoryEntry[] };
      setCount(getIncompleteTriggers(data.triggers ?? []).length);
    } catch {
      setCount(0);
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

  return count;
}
