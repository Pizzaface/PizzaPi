/**
 * useBrowserNotifications — fires in-browser Notification API alerts
 * and flashes the document title when an agent session is awaiting input
 * and the page is not visible/focused.
 *
 * This complements the existing Web Push notifications (which only fire
 * when no viewer tab is connected). Browser notifications cover the case
 * where the user has the tab open but is looking at another browser tab,
 * another window, or a different session.
 */
import { useEffect, useRef, useCallback } from "react";
import { getNotificationPermission } from "@/lib/push";

/** How often to alternate the document title when input is needed (ms). */
const TITLE_FLASH_INTERVAL_MS = 1500;

/**
 * Resolve a session label for the notification body.
 * Tries to find a human-readable name from the live sessions list,
 * otherwise falls back to the truncated session ID.
 */
function getSessionLabel(
  sessionId: string,
  sessionNames: Map<string, string | null>,
): string {
  const name = sessionNames.get(sessionId);
  return name ?? sessionId.slice(0, 8);
}

export interface BrowserNotificationOptions {
  /** Set of session IDs currently awaiting user input. */
  sessionsAwaitingInput: Set<string>;
  /** The currently active (viewed) session ID, or null. */
  activeSessionId: string | null;
  /**
   * Map of sessionId → sessionName for display in notifications.
   * Can be derived from liveSessions or the session cache.
   */
  sessionNames: Map<string, string | null>;
}

/**
 * Hook: fire browser notifications when sessions need input and the tab is
 * hidden or unfocused. Also flashes the document title as a secondary signal.
 *
 * Notifications are only shown when:
 * 1. The browser supports notifications (Notification API present)
 * 2. Permission has already been granted (we reuse the push permission — no
 *    extra prompt)
 * 3. The document is hidden OR the awaiting session is not the active one
 *
 * Each session gets at most one notification (tracked by a "notified" set).
 * When the session stops awaiting, the notification is auto-closed.
 */
export function useBrowserNotifications({
  sessionsAwaitingInput,
  activeSessionId,
  sessionNames,
}: BrowserNotificationOptions): void {
  // Track which sessions we've already notified about to avoid spam.
  const notifiedRef = useRef<Map<string, Notification>>(new Map());
  const originalTitleRef = useRef<string>(document.title);
  const flashIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasPermission = useCallback((): boolean => {
    if (!("Notification" in window)) return false;
    return getNotificationPermission() === "granted";
  }, []);

  // Clean up notifications for sessions that are no longer awaiting.
  useEffect(() => {
    const notified = notifiedRef.current;
    for (const [sessionId, notification] of notified) {
      if (!sessionsAwaitingInput.has(sessionId)) {
        notification.close();
        notified.delete(sessionId);
      }
    }
  }, [sessionsAwaitingInput]);

  // Fire notifications for newly awaiting sessions.
  useEffect(() => {
    if (!hasPermission()) return;

    const notified = notifiedRef.current;
    const isHidden = document.hidden;

    for (const sessionId of sessionsAwaitingInput) {
      // Already notified for this session.
      if (notified.has(sessionId)) continue;

      // If the tab is visible AND focused AND the user is viewing this session,
      // no need to notify — they can see the input prompt directly.
      // We check both document.hidden and document.hasFocus() because:
      // - document.hidden is false when the tab is visible but the user alt-tabbed
      // - document.hasFocus() catches the alt-tab case
      if (!isHidden && document.hasFocus() && sessionId === activeSessionId) continue;

      const label = getSessionLabel(sessionId, sessionNames);
      const notification = new Notification("Input needed", {
        body: `Agent in "${label}" is waiting for your input.`,
        icon: "/pwa-192x192.png",
        tag: `pizzapi-browser-input-${sessionId}`,
      } as NotificationOptions);

      // Clicking the notification focuses this tab.
      notification.onclick = () => {
        window.focus();
        // Dispatch a custom event so the app can navigate to the session.
        window.dispatchEvent(
          new CustomEvent("pp-navigate-session", { detail: { sessionId } }),
        );
        notification.close();
      };

      notified.set(sessionId, notification);
    }
  }, [sessionsAwaitingInput, activeSessionId, sessionNames, hasPermission]);

  // Flash the document title when any session is awaiting input and the tab is hidden.
  useEffect(() => {
    const awaitingCount = sessionsAwaitingInput.size;

    // Capture the "real" title once — before we start flashing.
    if (awaitingCount === 0 || !document.hidden) {
      // Restore original title and stop flashing.
      if (flashIntervalRef.current !== null) {
        clearInterval(flashIntervalRef.current);
        flashIntervalRef.current = null;
        document.title = originalTitleRef.current;
      }
      return;
    }

    // Already flashing.
    if (flashIntervalRef.current !== null) return;

    // Save the current (non-flashing) title.
    originalTitleRef.current = document.title;

    let showAlert = true;
    flashIntervalRef.current = setInterval(() => {
      document.title = showAlert
        ? `⚠️ Input needed — PizzaPi`
        : originalTitleRef.current;
      showAlert = !showAlert;
    }, TITLE_FLASH_INTERVAL_MS);

    return () => {
      if (flashIntervalRef.current !== null) {
        clearInterval(flashIntervalRef.current);
        flashIntervalRef.current = null;
        document.title = originalTitleRef.current;
      }
    };
  }, [sessionsAwaitingInput.size, sessionsAwaitingInput]);

  // Listen for visibility changes — when the user comes back, stop flashing
  // and close notifications for the active session.
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        // Stop title flashing.
        if (flashIntervalRef.current !== null) {
          clearInterval(flashIntervalRef.current);
          flashIntervalRef.current = null;
          document.title = originalTitleRef.current;
        }
        // Close notification for the active session (user is now looking at it).
        if (activeSessionId) {
          const n = notifiedRef.current.get(activeSessionId);
          if (n) {
            n.close();
            notifiedRef.current.delete(activeSessionId);
          }
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [activeSessionId]);

  // Cleanup all notifications on unmount.
  useEffect(() => {
    return () => {
      for (const [, n] of notifiedRef.current) {
        n.close();
      }
      notifiedRef.current.clear();
      if (flashIntervalRef.current !== null) {
        clearInterval(flashIntervalRef.current);
        flashIntervalRef.current = null;
        document.title = originalTitleRef.current;
      }
    };
  }, []);
}
