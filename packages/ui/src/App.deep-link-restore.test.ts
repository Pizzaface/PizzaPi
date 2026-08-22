import { describe, expect, test } from "bun:test";
import {
  cancelRestoreIntent,
  createRestoreIntent,
  takeRestoreTarget,
} from "./lib/deep-link-restore";

/**
 * Regression tests for dish C-004: a stale deep-link intent must not hijack a
 * session the user manually opened while the deep-link target was absent.
 *
 * App.tsx is not test-harnessed for full React rendering, so these live at the
 * pure ref-logic level — this module is exactly what App.tsx wires into its
 * auto-restore effect and openSession.
 */
describe("deep-link restore intent", () => {
  test("live deep-link target on first load restores (happy path)", () => {
    const intent = createRestoreIntent("/session/abc");
    const hit = takeRestoreTarget(intent, ["abc", "x"], "last-one");

    expect(hit).toEqual({ targetId: "abc", wasDeepLink: true });
    expect(intent.restored).toBe(true);
    expect(intent.deepLinkSessionId).toBeNull();
  });

  test("manual navigation cancels the armed intent; a later live update stays on the manual choice", () => {
    const intent = createRestoreIntent("/session/abc");

    // Deep-link target is absent on load: restore does not fire and the
    // intent stays armed (one-shot, waiting for the target to go live).
    expect(takeRestoreTarget(intent, ["x"], null)).toBeNull();
    expect(intent.restored).toBe(false);

    // User manually opens session "x" — openSession calls cancelRestoreIntent.
    cancelRestoreIntent(intent);

    // "abc" goes live later: the effect must NOT fire — the view stays on "x".
    expect(takeRestoreTarget(intent, ["abc", "x"], null)).toBeNull();
  });

  test("restore consumed once: second pass never re-fires", () => {
    const intent = createRestoreIntent("/session/abc");
    expect(takeRestoreTarget(intent, ["abc"], null)).not.toBeNull();
    expect(takeRestoreTarget(intent, ["abc"], null)).toBeNull();
  });

  test("no deep-link: falls back to lastSessionId", () => {
    const intent = createRestoreIntent("/");
    const hit = takeRestoreTarget(intent, ["s1", "s2"], "s2");

    expect(hit).toEqual({ targetId: "s2", wasDeepLink: false });
  });

  test("no restore at all before any live session arrives", () => {
    const intent = createRestoreIntent("/session/abc");
    expect(takeRestoreTarget(intent, [], "s1")).toBeNull();
    expect(intent.restored).toBe(false);
  });

  test("absent deep-link target blocks the lastSessionId fallback while armed", () => {
    const intent = createRestoreIntent("/session/absent");
    // Deep link wins over lastSessionId; while "absent" isn't live the intent
    // stays armed instead of falling back.
    expect(takeRestoreTarget(intent, ["s1"], "s1")).toBeNull();
    expect(intent.restored).toBe(false);
  });

  test("decodes URL-encoded deep-link IDs and ignores non-session paths", () => {
    expect(createRestoreIntent("/session/sess%3A42").deepLinkSessionId).toBe("sess:42");
    expect(createRestoreIntent("/session/abc/extra").deepLinkSessionId).toBe("abc");
    expect(createRestoreIntent("/").deepLinkSessionId).toBeNull();
    expect(createRestoreIntent("/settings").deepLinkSessionId).toBeNull();
    expect(createRestoreIntent("/session").deepLinkSessionId).toBeNull();
  });
});
