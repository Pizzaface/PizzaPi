import * as React from "react";
import type { HubSession } from "@/components/SessionSidebar";

/**
 * Keep only the members of `prev` that are still live. Returns `prev` itself
 * when nothing was dropped so React can bail out of the update.
 */
export function pruneToLiveSessions(prev: Set<string>, liveSessionIds: ReadonlySet<string>): Set<string> {
  const kept = Array.from(prev).filter((sessionId) => liveSessionIds.has(sessionId));
  return kept.length === prev.size ? prev : new Set(kept);
}

/**
 * Sidebar badge sets across ALL live sessions: sessions awaiting user input
 * (pending question / plan) and sessions actively compacting. Entries for
 * sessions that left the live list are pruned.
 */
export function useLiveSessionBadges(liveSessions: HubSession[]) {
  const [sessionsAwaitingInput, setSessionsAwaitingInput] = React.useState<Set<string>>(new Set());

  /** Set of session IDs that are actively compacting their context window. */
  const [sessionsCompacting, setSessionsCompacting] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    const liveSessionIds = new Set(liveSessions.map((session) => session.sessionId));
    setSessionsAwaitingInput((prev) => pruneToLiveSessions(prev, liveSessionIds));
    setSessionsCompacting((prev) => pruneToLiveSessions(prev, liveSessionIds));
  }, [liveSessions]);

  return { sessionsAwaitingInput, setSessionsAwaitingInput, sessionsCompacting, setSessionsCompacting };
}
