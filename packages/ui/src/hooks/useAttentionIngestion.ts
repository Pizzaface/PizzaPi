/**
 * useAttentionIngestion — feeds session meta + trigger data into the attention store.
 *
 * Must be called inside an <AttentionProvider>. Reacts to changes in:
 * - Active session meta state (pendingQuestion, pendingPlan, etc.)
 * - Trigger count changes (refetches trigger history)
 */
import { useCallback, useEffect, useRef } from "react";
import {
  useAttentionStore,
  normalizeBackgroundSessionMeta,
  normalizeSessionMeta,
  normalizeTriggerHistory,
  type SessionMetaForAttention,
} from "@/attention";
import type { TriggerHistoryEntry } from "@/components/TriggersPanel";
import type { TriggerCounts } from "@/hooks/useTriggerCount";

export interface AttentionIngestionParams {
  activeSessionId: string | null;
  pendingQuestion: { toolCallId: string } | null;
  pendingPlan: { toolCallId: string; title: string } | null;
  pluginTrustPrompt: { promptId: string } | null;
  isCompacting: boolean;
  agentActive: boolean;
  sessionName: string | null;
  triggerCounts: TriggerCounts;
  sessionsAwaitingInput: ReadonlySet<string>;
  sessionsCompacting: ReadonlySet<string>;
  sessionNamesById?: ReadonlyMap<string, string>;
}

/**
 * Hook that feeds session meta and trigger data into the attention store.
 * Call this inside any component that's wrapped by <AttentionProvider>.
 */
export function useAttentionIngestion(params: AttentionIngestionParams): void {
  const store = useAttentionStore();
  const {
    activeSessionId,
    pendingQuestion,
    pendingPlan,
    pluginTrustPrompt,
    isCompacting,
    agentActive,
    sessionName,
    triggerCounts,
    sessionsAwaitingInput,
    sessionsCompacting,
    sessionNamesById,
  } = params;

  // P1: track previous session ID so we can purge its items on switch
  const prevSessionIdRef = useRef<string | null>(null);
  const prevBackgroundSessionIdsRef = useRef<Set<string>>(new Set());
  // P2: stable first-seen createdAt timestamps keyed by item ID
  const createdAtRef = useRef<Map<string, string>>(new Map());

  const preserveCreatedAt = useCallback((items: ReturnType<typeof normalizeSessionMeta>) =>
    items.map((item) => {
      const stored = createdAtRef.current.get(item.id);
      if (stored) return { ...item, createdAt: stored };
      createdAtRef.current.set(item.id, item.createdAt);
      return item;
    }), []);

  // Ingest session meta changes into the attention store
  useEffect(() => {
    if (!activeSessionId) {
      if (prevSessionIdRef.current) {
        store.removeBySessionId(prevSessionIdRef.current);
      }
      prevSessionIdRef.current = null;
      return;
    }

    // P1: when switching sessions, remove the previous session's items
    if (prevSessionIdRef.current && prevSessionIdRef.current !== activeSessionId) {
      store.removeBySessionId(prevSessionIdRef.current);
    }
    prevSessionIdRef.current = activeSessionId;

    const meta: SessionMetaForAttention = {
      pendingQuestion: pendingQuestion ? { toolCallId: pendingQuestion.toolCallId } : null,
      pendingPlan: pendingPlan ? { toolCallId: pendingPlan.toolCallId, title: pendingPlan.title } : null,
      pluginTrustPrompt: pluginTrustPrompt ? { promptId: pluginTrustPrompt.promptId } : null,
      isCompacting,
      agentActive,
      sessionName,
    };
    const items = preserveCreatedAt(normalizeSessionMeta(activeSessionId, meta));

    store.replaceBySessionSource(activeSessionId, "meta", items);
  }, [activeSessionId, pendingQuestion, pendingPlan, pluginTrustPrompt, isCompacting, agentActive, sessionName, preserveCreatedAt, store]);

  // Ingest background-session meta so the Action Center stays cross-session.
  useEffect(() => {
    const nextBackgroundSessionIds = new Set<string>();
    for (const sessionId of sessionsAwaitingInput) {
      if (sessionId !== activeSessionId) {
        nextBackgroundSessionIds.add(sessionId);
      }
    }
    for (const sessionId of sessionsCompacting) {
      if (sessionId !== activeSessionId) {
        nextBackgroundSessionIds.add(sessionId);
      }
    }

    for (const sessionId of nextBackgroundSessionIds) {
      const items = preserveCreatedAt(normalizeBackgroundSessionMeta(sessionId, {
        awaitingInputKind: sessionsAwaitingInput.has(sessionId) ? "question" : null,
        isCompacting: sessionsCompacting.has(sessionId),
        sessionName: sessionNamesById?.get(sessionId) ?? null,
      }));
      store.replaceBySessionSource(sessionId, "meta", items);
    }

    for (const sessionId of prevBackgroundSessionIdsRef.current) {
      if (!nextBackgroundSessionIds.has(sessionId) && sessionId !== activeSessionId) {
        store.replaceBySessionSource(sessionId, "meta", []);
      }
    }

    prevBackgroundSessionIdsRef.current = nextBackgroundSessionIds;
  }, [activeSessionId, preserveCreatedAt, sessionsAwaitingInput, sessionsCompacting, sessionNamesById, store]);

  // Ingest trigger history when trigger counts change
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(activeSessionId)}/triggers?limit=50`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { triggers?: TriggerHistoryEntry[] };
        if (cancelled || !data.triggers) return;
        const items = normalizeTriggerHistory(activeSessionId, data.triggers);
        store.replaceBySessionSource(activeSessionId, "trigger", items);
      } catch {
        // Best-effort — don't crash if fetch fails
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run when triggerCounts change (indicates trigger history changed).
    // historyLength is included so that any new inbound trigger (even non-pending
    // service triggers) causes re-ingestion, not just changes to pending/subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, triggerCounts.pending, triggerCounts.subscriptions, triggerCounts.historyLength, store]);
}
