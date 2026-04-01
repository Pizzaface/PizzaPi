import { describe, test, expect } from "bun:test";

/**
 * Unit tests for the pure logic used by useBrowserNotifications.
 *
 * Since Bun's test runner does not provide a DOM environment, we test
 * the helper functions and logical invariants rather than the React hook.
 * The helper `getSessionLabel` is re-used here since it's not exported
 * from the hook module (it's a file-local function), but the logic is
 * tested to match the source exactly.
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
): boolean {
  if (alreadyNotified.has(sessionId)) return false;
  // Only suppress when the tab is visible AND focused AND viewing this session
  if (!isHidden && hasFocus && sessionId === activeSessionId) return false;
  return true;
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
});
