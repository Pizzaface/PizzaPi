/**
 * One-shot "restore my session" intent for App.tsx.
 *
 * On load, a /session/<id> URL (deep link) takes priority over the stored
 * lastSessionId. The intent is armed until the restore actually fires OR the
 * user navigates manually — whichever comes first. While armed and the target
 * is absent, no restore happens; if the user then opens a session by hand and
 * the deep-link target goes live later, the already-cancelled intent must not
 * fire (it would hijack the session the user chose).
 */

export interface RestoreIntent {
  /** Whether the one-shot intent has been resolved (fired or cancelled). */
  restored: boolean;
  /** Session ID decoded from a /session/<id> URL at mount, if any. */
  deepLinkSessionId: string | null;
}

/** Capture the initial intent from the URL the page was loaded with. */
export function createRestoreIntent(pathname: string): RestoreIntent {
  const m = pathname.match(/^\/session\/([^/]+)(?:\/|$)/);
  return {
    restored: false,
    deepLinkSessionId: m ? decodeURIComponent(m[1]) : null,
  };
}

/**
 * Manual navigation disarms the one-shot intent so a stale deep-link can never
 * override a session the user opened by hand. The restore path itself consumes
 * the intent before opening, so this is a no-op there.
 */
export function cancelRestoreIntent(intent: RestoreIntent): void {
  intent.restored = true;
  intent.deepLinkSessionId = null;
}

/**
 * Decide whether to auto-restore now. Consumes the intent when it fires;
 * leaves it armed (waiting for the target to go live) when it doesn't.
 *
 * Returns null when nothing should be opened. When the consumed target came
 * from the deep-link URL, `wasDeepLink` is true so the caller can replace the
 * URL (a reload must not re-trigger the deep-link).
 */
export function takeRestoreTarget(
  intent: RestoreIntent,
  liveSessionIds: readonly string[],
  lastSessionId: string | null,
): { targetId: string; wasDeepLink: boolean } | null {
  if (intent.restored || liveSessionIds.length === 0) return null;
  const targetId = intent.deepLinkSessionId ?? lastSessionId;
  if (!targetId || !liveSessionIds.includes(targetId)) return null;
  intent.restored = true;
  const wasDeepLink = intent.deepLinkSessionId !== null;
  intent.deepLinkSessionId = null;
  return { targetId, wasDeepLink };
}
