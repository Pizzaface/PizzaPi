import { describe, test, expect } from "bun:test";
import * as browserNotifications from "../lib/browser-notifications";

/**
 * Unit tests for the logic used by useBrowserNotifications.
 *
 * Since Bun's test runner does not provide a DOM environment, we test
 * the helper functions and logical invariants rather than the React hook
 * itself.
 */

// ── Extracted from useBrowserNotifications.ts ───────────────────────────────
// Mirrors the file-local getSessionLabel helper.
function getSessionLabel(
  sessionId: string,
  sessionNames: Map<string, string | null>,
): string {
  const name = sessionNames.get(sessionId);
  return name ?? sessionId.slice(0, 8);
}

/**
 * Mirrors the hook's logic for deciding whether to show a notification
 * for a given session. Updated to match the hasFocus() fix.
 */
function shouldNotify(
  sessionId: string,
  activeSessionId: string | null,
  isHidden: boolean,
  hasFocus: boolean,
  alreadyNotified: Set<string>,
  seenWhileActive: Set<string> = new Set(),
): boolean {
  if (alreadyNotified.has(sessionId)) return false;
  if (seenWhileActive.has(sessionId)) return false;
  // Only suppress when the tab is visible AND focused AND viewing this session
  if (!isHidden && hasFocus && sessionId === activeSessionId) return false;
  return true;
}

// Mirrors the hook's "mark seen while active" effect: a session gets
// marked as already-seen the moment it's awaiting input while actively
// viewed (visible + focused).
function markSeenWhileActive(
  sessionsAwaitingInput: Set<string>,
  activeSessionId: string | null,
  isHidden: boolean,
  hasFocus: boolean,
  seenWhileActive: Set<string>,
): void {
  if (!isHidden && hasFocus && activeSessionId && sessionsAwaitingInput.has(activeSessionId)) {
    seenWhileActive.add(activeSessionId);
  }
}

// Mirrors the hook's visibilitychange handler: returning to the tab closes the
// notification, clears the notified record AND marks the session as seen.
// Marking here is essential — the markSeenWhileActive effect only re-runs on
// React state changes, and visibilitychange is a DOM event.
function onVisibilityReturn(
  activeSessionId: string | null,
  sessionsAwaitingInput: Set<string>,
  alreadyNotified: Set<string>,
  seenWhileActive: Set<string>,
): void {
  if (!activeSessionId) return;
  alreadyNotified.delete(activeSessionId);
  if (sessionsAwaitingInput.has(activeSessionId)) {
    seenWhileActive.add(activeSessionId);
  }
}

describe("useBrowserNotifications logic", () => {
  // ── Session label resolution ───────────────────────────────────────────

  test("session label falls back to truncated ID when name is null", () => {
    const names = new Map<string, string | null>();
    names.set("abc12345-long-session-id", null);
    expect(getSessionLabel("abc12345-long-session-id", names)).toBe("abc12345");
  });

  test("session label falls back to truncated ID when session not in map", () => {
    const names = new Map<string, string | null>();
    expect(getSessionLabel("xyz98765-unknown-session", names)).toBe("xyz98765");
  });

  test("session label uses session name when available", () => {
    const names = new Map<string, string | null>();
    names.set("abc12345-long-session-id", "My Cool Session");
    expect(getSessionLabel("abc12345-long-session-id", names)).toBe("My Cool Session");
  });

  // ── Notification decision logic ────────────────────────────────────────

  test("reading a prompt after returning to the tab, then switching sessions, does not re-notify", () => {
    const awaiting = new Set(["s1"]);
    const notified = new Set<string>();
    const seen = new Set<string>();

    // 1. Tab hidden when the question arrives → notify.
    expect(shouldNotify("s1", "s1", true, false, notified, seen)).toBe(true);
    notified.add("s1");

    // 2. User returns to the tab and reads it.
    onVisibilityReturn("s1", awaiting, notified, seen);
    expect(notified.has("s1")).toBe(false); // record cleared, notification closed
    expect(seen.has("s1")).toBe(true); // but now marked as seen

    // 3. User switches to another session while s1 is still awaiting.
    //    Without the visibilitychange marking this would re-notify.
    expect(shouldNotify("s1", "s2", false, true, notified, seen)).toBe(false);
  });

  test("returning to the tab does not mark a session that is not awaiting", () => {
    const notified = new Set<string>(["s1"]);
    const seen = new Set<string>();
    onVisibilityReturn("s1", new Set(), notified, seen);
    expect(seen.has("s1")).toBe(false);
  });

  test("should notify when tab is hidden", () => {
    expect(shouldNotify("s1", "s1", true, false, new Set())).toBe(true);
  });

  test("should notify for background session even when tab is visible and focused", () => {
    expect(shouldNotify("s2", "s1", false, true, new Set())).toBe(true);
  });

  test("should NOT notify for active session when tab is visible AND focused", () => {
    expect(shouldNotify("s1", "s1", false, true, new Set())).toBe(false);
  });

  test("should notify for active session when tab is visible but NOT focused (alt-tabbed)", () => {
    // Key P1 fix: user alt-tabbed away — tab is visible but unfocused
    expect(shouldNotify("s1", "s1", false, false, new Set())).toBe(true);
  });

  test("should NOT notify when already notified", () => {
    expect(shouldNotify("s1", null, true, false, new Set(["s1"]))).toBe(false);
  });

  // ── Title flash pattern ────────────────────────────────────────────────

  test("title flash alternates between alert and original", () => {
    const original = "PizzaPi";
    const alert = "⚠️ Input needed — PizzaPi";
    let showAlert = true;
    const titles: string[] = [];
    for (let i = 0; i < 4; i++) {
      titles.push(showAlert ? alert : original);
      showAlert = !showAlert;
    }
    expect(titles).toEqual([alert, original, alert, original]);
  });

  // ── Notification tag uniqueness ────────────────────────────────────────

  test("notification tags are unique per session ID", () => {
    const tag = (id: string) => `pizzapi-browser-input-${id}`;
    expect(tag("session-a")).not.toBe(tag("session-b"));
    expect(tag("session-a")).toBe("pizzapi-browser-input-session-a");
  });

  // ── Cleanup: sessions removed from awaiting set ────────────────────────

  test("sessions removed from awaiting set should be cleaned up", () => {
    const notified = new Map<string, { closed: boolean }>();
    notified.set("s1", { closed: false });
    notified.set("s2", { closed: false });

    const stillAwaiting = new Set(["s1"]);

    // Simulate cleanup loop from the hook
    for (const [sessionId, notification] of notified) {
      if (!stillAwaiting.has(sessionId)) {
        notification.closed = true;
        notified.delete(sessionId);
      }
    }

    expect(notified.size).toBe(1);
    expect(notified.has("s1")).toBe(true);
    expect(notified.has("s2")).toBe(false);
  });

  test("shows browser input notifications through the service worker registration", async () => {
    const calls: Array<{ title: string; options: any }> = [];
    const registration = {
      showNotification: async (title: string, options: any) => {
        calls.push({ title, options });
      },
    };

    await browserNotifications.showBrowserInputNotification(
      registration,
      "session-123",
      "My Cool Session",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Input needed");
    expect(calls[0].options.tag).toBe("pizzapi-browser-input-session-123");
    expect(calls[0].options.body).toBe(
      'Agent in "My Cool Session" is waiting for your input.',
    );
    expect(calls[0].options.data).toEqual({
      sessionId: "session-123",
      type: "browser_input",
    });
  });

  test("session that starts awaiting while actively viewed does not notify after switching away", () => {
    const seenWhileActive = new Set<string>();
    const awaiting = new Set(["s1"]);

    markSeenWhileActive(awaiting, "s1", false, true, seenWhileActive);
    expect(seenWhileActive.has("s1")).toBe(true);

    expect(shouldNotify("s1", "s1", false, true, new Set(), seenWhileActive)).toBe(false);
    expect(shouldNotify("s1", "s2", false, true, new Set(), seenWhileActive)).toBe(false);
    expect(shouldNotify("s1", "s2", true, false, new Set(), seenWhileActive)).toBe(false);
  });

  test("session that starts awaiting while NOT actively viewed still notifies", () => {
    const seenWhileActive = new Set<string>();
    const awaiting = new Set(["s1"]);

    markSeenWhileActive(awaiting, "s2", false, true, seenWhileActive);
    expect(seenWhileActive.has("s1")).toBe(false);

    expect(shouldNotify("s1", "s2", false, true, new Set(), seenWhileActive)).toBe(true);
  });

  test("seen-while-active entries are cleared once the session stops awaiting", () => {
    const seenWhileActive = new Set(["s1", "s2"]);
    const stillAwaiting = new Set(["s1"]);

    for (const sessionId of Array.from(seenWhileActive)) {
      if (!stillAwaiting.has(sessionId)) {
        seenWhileActive.delete(sessionId);
      }
    }

    expect(seenWhileActive.has("s1")).toBe(true);
    expect(seenWhileActive.has("s2")).toBe(false);
  });

  test("extracts session id from service worker open-session messages", () => {
    expect(
      browserNotifications.getOpenSessionMessageSessionId({
        type: "open-session",
        sessionId: "session-123",
      }),
    ).toBe("session-123");
    expect(browserNotifications.getOpenSessionMessageSessionId({ type: "other" })).toBeNull();
    expect(browserNotifications.getOpenSessionMessageSessionId(null)).toBeNull();
  });
});
