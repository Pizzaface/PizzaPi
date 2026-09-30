import type { SessionUiCacheEntry } from "@/lib/types";

/**
 * Merge a partial patch into a session UI cache entry, filling every field
 * from `prev` (or its default) first. `lastAccessed` is always stamped with
 * `now`, overriding any value in the patch.
 */
export function buildSessionCacheEntry(
  prev: SessionUiCacheEntry | undefined,
  patch: Partial<SessionUiCacheEntry>,
  now: number,
): SessionUiCacheEntry {
  return {
    snapshotMessages: prev?.snapshotMessages,
    messages: prev?.messages ?? [],
    activeModel: prev?.activeModel ?? null,
    sessionName: prev?.sessionName ?? null,
    availableModels: prev?.availableModels ?? [],
    availableCommands: prev?.availableCommands ?? [],
    agentActive: prev?.agentActive ?? false,
    isCompacting: prev?.isCompacting ?? false,
    effortLevel: prev?.effortLevel ?? null,
    planModeEnabled: prev?.planModeEnabled ?? false,
    authSource: prev?.authSource ?? null,
    tokenUsage: prev?.tokenUsage ?? null,
    providerUsage: prev?.providerUsage ?? null,
    lastHeartbeatAt: prev?.lastHeartbeatAt ?? null,
    todoList: prev?.todoList ?? [],
    messageQueue: prev?.messageQueue ?? [],
    analysis: prev?.analysis ?? null,
    pendingQuestion: prev?.pendingQuestion ?? null,
    pendingPlan: prev?.pendingPlan ?? null,
    goal: prev?.goal ?? null,
    ...patch,
    lastAccessed: now,
  };
}

/** True when the patch touches the fields that drive the "awaiting input" badge. */
export function patchTouchesAwaitingInput(patch: Partial<SessionUiCacheEntry>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, "pendingQuestion") ||
    Object.prototype.hasOwnProperty.call(patch, "pendingPlan");
}

/**
 * Return a NEW set with `id` added (`present`) or removed. Always copies, even
 * when membership is unchanged — callers rely on the fresh identity.
 */
export function withSetMember<T>(prev: ReadonlySet<T>, id: T, present: boolean): Set<T> {
  const next = new Set(prev);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}
