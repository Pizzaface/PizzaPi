/** A plan awaiting user review (plan_mode tool). */
export interface PendingPlan {
  toolCallId: string;
  title: string;
  description: string | null;
  steps: Array<{ title: string; description?: string }>;
}

/**
 * Parse plan_mode tool args / partial-result details from a relay
 * `tool_execution_start|update` event. Step titles and descriptions are
 * trimmed; empty-titled steps are dropped. Returns null when the source has
 * no non-empty title. `fallbackToolCallId` is only called when the event's
 * toolCallId is not a string.
 */
export function parsePlanModeSource(
  source: Record<string, unknown> | undefined,
  toolCallId: unknown,
  fallbackToolCallId: () => string,
): PendingPlan | null {
  if (!source || typeof source.title !== "string" || !source.title.trim()) return null;
  const steps = Array.isArray(source.steps)
    ? (source.steps as unknown[])
        .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
        .map((s) => ({
          title: typeof s.title === "string" ? (s.title as string).trim() : "",
          description: typeof s.description === "string" && (s.description as string).trim()
            ? (s.description as string).trim()
            : undefined,
        }))
        .filter((s) => s.title.length > 0)
    : [];
  return {
    toolCallId: typeof toolCallId === "string" ? toolCallId : fallbackToolCallId(),
    title: (source.title as string).trim(),
    description: typeof source.description === "string" && (source.description as string).trim() ? (source.description as string).trim() : null,
    steps,
  };
}

/**
 * Normalize a pendingPlan carried in hub meta state (snapshot or patch).
 * Steps are filtered (non-empty title) but NOT trimmed, matching the relay
 * payload as-is. With `requireNonEmptyTitle`, a whitespace-only title is
 * rejected (snapshot semantics); otherwise any string title is accepted
 * (patch semantics). Returns null when invalid.
 */
export function normalizeMetaPendingPlan(
  pp: unknown,
  requireNonEmptyTitle: boolean,
): PendingPlan | null {
  if (!pp || typeof pp !== "object") return null;
  const plan = pp as { toolCallId?: unknown; title?: unknown; description?: unknown; steps?: unknown };
  if (typeof plan.toolCallId !== "string" || typeof plan.title !== "string") return null;
  if (requireNonEmptyTitle && !plan.title.trim()) return null;
  const steps = Array.isArray(plan.steps)
    ? plan.steps.filter((s): s is { title: string; description?: string } =>
        s !== null && typeof s === "object" && typeof (s as { title?: unknown }).title === "string" && (s as { title: string }).title.trim().length > 0,
      )
    : [];
  return {
    toolCallId: plan.toolCallId,
    title: plan.title.trim(),
    description: typeof plan.description === "string" && plan.description.trim() ? plan.description.trim() : null,
    steps,
  };
}
