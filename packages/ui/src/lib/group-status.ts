/**
 * Pure logic for computing group (parent→children) completion status.
 * Extracted so it can be tested independently of React components.
 */

/** Minimal session shape needed for group status computation */
export interface GroupSession {
  sessionId: string;
  isActive?: boolean;
  lastHeartbeatAt?: string | null;
  childSessionIds?: string[];
  parentSessionId?: string | null;
  sessionName?: string | null;
  model?: { provider: string; id: string; name?: string } | null;
  startedAt?: string;
}

/** Status category for a child session */
export type ChildStatus = "active" | "idle" | "completed" | "error" | "unknown";

/** A child session with its resolved status */
export interface ResolvedChild {
  sessionId: string;
  displayName: string;
  status: ChildStatus;
  model: { provider: string; id: string; name?: string } | null;
  /** Duration in milliseconds since session started */
  durationMs: number | null;
}

/** Group completion counts */
export interface GroupCompletionCounts {
  completed: number;
  active: number;
  error: number;
  total: number;
}

/**
 * Determine the status of a session based on its heartbeat/active state.
 *
 * A session is considered "completed" when it is no longer active AND its
 * heartbeat is stale (>60s old). An active session is "active". A recently
 * seen but inactive session is "idle". Very stale (>120s) and not active
 * is treated as "error" (disconnected).
 */
export function resolveChildStatus(session: GroupSession): ChildStatus {
  if (session.isActive) return "active";

  if (session.lastHeartbeatAt) {
    const hbAge = Date.now() - new Date(session.lastHeartbeatAt).getTime();
    if (hbAge > 120_000) return "error"; // disconnected
    if (hbAge > 60_000) return "completed"; // stale = finished
    return "idle";
  }

  return "unknown";
}

/**
 * Compute group completion counts from a session's child IDs
 * and a lookup map of all sessions.
 */
export function computeGroupCounts(
  childSessionIds: string[],
  sessionsById: Map<string, GroupSession>,
): GroupCompletionCounts {
  let completed = 0;
  let active = 0;
  let error = 0;
  const total = childSessionIds.length;

  for (const childId of childSessionIds) {
    const child = sessionsById.get(childId);
    if (!child) {
      // Session no longer in the live list — treat as completed
      completed++;
      continue;
    }
    const status = resolveChildStatus(child);
    if (status === "completed") completed++;
    else if (status === "active") active++;
    else if (status === "error") error++;
    // idle and unknown don't increment any counter
  }

  return { completed, active, error, total };
}

/**
 * Resolve child sessions into a list of ResolvedChild objects
 * suitable for rendering in the GroupMembersPanel.
 */
export function resolveChildSessions(
  childSessionIds: string[],
  sessionsById: Map<string, GroupSession>,
): ResolvedChild[] {
  const now = Date.now();

  return childSessionIds.map((childId) => {
    const child = sessionsById.get(childId);

    if (!child) {
      return {
        sessionId: childId,
        displayName: `Session ${childId.slice(0, 8)}…`,
        status: "completed" as ChildStatus,
        model: null,
        durationMs: null,
      };
    }

    const status = resolveChildStatus(child);
    const displayName =
      child.sessionName?.trim() || `Session ${childId.slice(0, 8)}…`;
    const durationMs = child.startedAt
      ? now - new Date(child.startedAt).getTime()
      : null;

    return {
      sessionId: childId,
      displayName,
      status,
      model: child.model ?? null,
      durationMs,
    };
  });
}

/**
 * Format a duration in milliseconds into a human-readable string.
 * Examples: "12s", "3m 45s", "1h 23m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
