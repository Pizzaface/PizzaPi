import * as React from "react";
import type { SessionUiCacheEntry } from "@/lib/types";
import type { SessionLifecycleRefs } from "@/lib/use-session-lifecycle";
import { evictLruIfNeeded, MAX_SESSION_UI_CACHE_SIZE } from "@/lib/session-ui-cache";
import { buildSessionCacheEntry, patchTouchesAwaitingInput, withSetMember } from "./session-cache-entry";

/**
 * Per-relay-session UI cache so switching sessions feels instant.
 * `patchSessionCache` writes to the ACTIVE session's entry (read from the
 * lifecycle ref at call time) and keeps the sidebar "awaiting input" set in
 * sync with pendingQuestion / pendingPlan.
 */
export function useSessionUiCache(
  lifecycleRefs: SessionLifecycleRefs,
  setSessionsAwaitingInput: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  // Cache last-known UI state per relay session so switching sessions feels instant.
  const sessionUiCacheRef = React.useRef<Map<string, SessionUiCacheEntry>>(new Map());
  // Pin the exact snapshot offered by this switch, even if live state changes before its reply.
  const requestedSnapshotMessagesRef = React.useRef<SessionUiCacheEntry["snapshotMessages"]>(undefined);

  const patchSessionCache = React.useCallback((patch: Partial<SessionUiCacheEntry>) => {
    const sessionId = lifecycleRefs.activeSessionId.current;
    if (!sessionId) return;

    const prev = sessionUiCacheRef.current.get(sessionId);
    const next = buildSessionCacheEntry(prev, patch, Date.now());

    // Evict the least-recently-accessed entry if we're over the size limit.
    evictLruIfNeeded(sessionUiCacheRef.current, sessionId, MAX_SESSION_UI_CACHE_SIZE, lifecycleRefs.activeSessionId.current);

    sessionUiCacheRef.current.set(sessionId, next);

    // Keep the sidebar indicator in sync: track which sessions are awaiting input
    // (either a pending question or a pending plan review).
    if (patchTouchesAwaitingInput(patch)) {
      setSessionsAwaitingInput((prev) =>
        withSetMember(prev, sessionId, !!(patch.pendingQuestion || patch.pendingPlan)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSessionsAwaitingInput]);

  return { sessionUiCacheRef, requestedSnapshotMessagesRef, patchSessionCache };
}
