/**
 * Normalizers — convert raw session meta / trigger data into AttentionItems.
 *
 * Each normalizer produces a list of items with stable IDs so the store can
 * deduplicate on upsert. IDs are deterministic based on (sessionId, source, kind)
 * to avoid ghost items when heartbeats re-deliver the same state.
 */
import type { AttentionItem } from "./types";
import type { TriggerHistoryEntry } from "./trigger-utils";
import { isPendingTrigger, RESPONSE_TRIGGER_TYPES } from "./trigger-utils";

// ── Session Meta Normalization ──────────────────────────────────────────────

/**
 * Shape of per-session metadata that gets fed into the attention store.
 * This is a subset of what App.tsx tracks — we only care about attention-relevant fields.
 */
export interface SessionMetaForAttention {
  pendingQuestion?: { toolCallId: string } | null;
  pendingPlan?: { toolCallId: string; title: string } | null;
  pluginTrustPrompt?: { promptId: string } | null;
  isCompacting?: boolean;
  agentActive?: boolean;
  sessionName?: string | null;
}

/**
 * Minimal background-session signals that App.tsx tracks globally even when a
 * session is not active. These are intentionally lossy — background sessions
 * currently expose "awaiting input" as a session-level flag, not the full
 * prompt payload, so we synthesize a stable attention item from that fact.
 */
export interface BackgroundSessionMetaForAttention {
  awaitingInputKind?: "question" | "plan_review" | null;
  isCompacting?: boolean;
  sessionName?: string | null;
}

/**
 * Extract attention items from a session's meta state snapshot.
 * Called whenever session meta changes (heartbeat, state_snapshot, meta_event).
 */
export function normalizeSessionMeta(
  sessionId: string,
  meta: SessionMetaForAttention,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = new Date().toISOString();
  const name = meta.sessionName ?? undefined;

  if (meta.pendingQuestion) {
    items.push({
      id: `meta:${sessionId}:question:${meta.pendingQuestion.toolCallId}`,
      category: "needs_response",
      kind: "question",
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 10,
      source: "meta",
      payload: meta.pendingQuestion,
    });
  }

  if (meta.pendingPlan) {
    items.push({
      id: `meta:${sessionId}:plan:${meta.pendingPlan.toolCallId}`,
      category: "needs_response",
      kind: "plan_review",
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 10,
      source: "meta",
      payload: meta.pendingPlan,
    });
  }

  if (meta.pluginTrustPrompt) {
    items.push({
      id: `meta:${sessionId}:plugin_trust:${meta.pluginTrustPrompt.promptId}`,
      category: "needs_response",
      kind: "plugin_trust",
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 15,
      source: "meta",
      payload: meta.pluginTrustPrompt,
    });
  }

  if (meta.isCompacting) {
    items.push({
      id: `meta:${sessionId}:compacting`,
      category: "running",
      kind: "compacting",
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 40,
      source: "meta",
    });
  }

  if (meta.agentActive) {
    items.push({
      id: `meta:${sessionId}:active`,
      category: "running",
      kind: "agent_active",
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 50,
      source: "meta",
    });
  }

  return items;
}

// ── Trigger History Normalization ───────────────────────────────────────────

/**
 * Extract attention items from trigger history entries.
 * Produces items for: pending interactive triggers (needs_response),
 * running child sessions (running), completed sessions (completed).
 */
export function normalizeBackgroundSessionMeta(
  sessionId: string,
  meta: BackgroundSessionMetaForAttention,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = new Date().toISOString();
  const name = meta.sessionName ?? undefined;

  if (meta.awaitingInputKind) {
    items.push({
      id: `meta:${sessionId}:background:${meta.awaitingInputKind}`,
      category: "needs_response",
      kind: meta.awaitingInputKind,
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 10,
      source: "meta",
      payload: { background: true },
    });
  }

  if (meta.isCompacting) {
    items.push({
      id: `meta:${sessionId}:compacting`,
      category: "running",
      kind: "compacting",
      sessionId,
      sessionName: name,
      createdAt: now,
      priority: 40,
      source: "meta",
    });
  }

  return items;
}

export function normalizeTriggerHistory(
  sessionId: string,
  triggers: TriggerHistoryEntry[],
): AttentionItem[] {
  const items: AttentionItem[] = [];

  /**
   * Only classify a trigger source as a child session if it looks like a UUID.
   * Runner-service sources (e.g. "github", "godmother", "time") are plain strings,
   * never UUIDs — they don't emit session_complete and must not be tracked as
   * child sessions.  The old exclusion-list approach ("api", "external:*") was
   * incomplete; UUID matching is unambiguous and future-proof.
   */
  const isChildSessionSource = (source: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source);

  // Group by source to detect child session lifecycle
  const sourceGroups = new Map<string, TriggerHistoryEntry[]>();
  for (const t of triggers) {
    if (t.direction !== "inbound") continue;
    const key = t.source || "unknown";
    const group = sourceGroups.get(key);
    if (group) group.push(t);
    else sourceGroups.set(key, [t]);
  }

  for (const [source, events] of sourceGroups) {
    // Skip non-UUID sources — they are not child sessions
    if (!isChildSessionSource(source)) continue;

    const pending = events.find(isPendingTrigger);
    const hasCompleted = events.some((e) => e.type === "session_complete");
    const summary = events[0]?.summary;

    if (pending) {
      // Pending interactive trigger from a child session
      const kindMap: Record<string, AttentionItem["kind"]> = {
        ask_user_question: "trigger_response",
        plan_review: "trigger_response",
        escalate: "trigger_response",
      };
      items.push({
        id: `trigger:${sessionId}:${pending.triggerId}`,
        category: "needs_response",
        kind: kindMap[pending.type] ?? "trigger_response",
        sessionId,
        sessionName: summary ?? undefined,
        createdAt: pending.ts,
        priority: pending.type === "escalate" ? 5 : 10,
        source: "trigger",
        payload: { triggerId: pending.triggerId, type: pending.type, source, summary },
      });
    } else if (hasCompleted) {
      // triggers are ordered most-recent-first from the API; find() returns the newest session_complete
      const completeEvent = events.find((e) => e.type === "session_complete")!;
      const responseAction = completeEvent.response?.action;

      if (responseAction === "followUp") {
        items.push({
          id: `trigger:${sessionId}:running:${source}`,
          category: "running",
          kind: "child_running",
          sessionId,
          sessionName: summary ?? undefined,
          createdAt: completeEvent.response?.ts ?? completeEvent.ts,
          priority: 50,
          source: "trigger",
          payload: { triggerId: completeEvent.triggerId, source, summary, resumedFromComplete: true },
        });
      } else {
        items.push({
          id: `trigger:${sessionId}:complete:${source}`,
          category: "completed",
          kind: "session_complete",
          sessionId,
          sessionName: summary ?? undefined,
          createdAt: completeEvent.ts,
          priority: 30,
          source: "trigger",
          payload: { triggerId: completeEvent.triggerId, source, summary },
        });
      }
    } else {
      // Child session is running (connected, no completion, no pending)
      items.push({
        id: `trigger:${sessionId}:running:${source}`,
        category: "running",
        kind: "child_running",
        sessionId,
        sessionName: summary ?? undefined,
        createdAt: events[0]?.ts ?? new Date().toISOString(),
        priority: 50,
        source: "trigger",
        payload: { source, summary },
      });
    }
  }

  return items;
}
