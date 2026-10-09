import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Guard: opening a session must reset the stale-watchdog backoff counter.
 *
 * consecutiveStaleReconnectsRef persists across session switches (it lives
 * outside openSession's per-call scope). Without resetting it, leaving a
 * dead-runner session at the 8x backoff cap and opening a brand-new, silent
 * session inherits that 8x multiplier — its watchdog would wait up to 240s
 * instead of the base 30s even though it never failed a reconnect itself.
 */
describe("App openSession stale-backoff reset", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const openSessionBlock = (() => {
    const start = src.indexOf("const openSession = React.useCallback");
    // Bound the slice to the synchronous setup at the top of openSession,
    // before the socket is (re)created — the socket's own event handlers
    // below also touch consecutiveStaleReconnectsRef (the exec_result and
    // stale-watchdog-event handlers), which would make this guard pass even
    // without the fix if the slice extended into them.
    const end = src.indexOf("socket = io(", start);
    return src.slice(start, end);
  })();

  test("openSession resets consecutiveStaleReconnectsRef", () => {
    expect(openSessionBlock).toMatch(/consecutiveStaleReconnectsRef\.current\s*=\s*0/);
  });

  test("openSession still resets lastViewerEventAtRef (treat open as an event)", () => {
    expect(openSessionBlock).toMatch(/lastViewerEventAtRef\.current\s*=\s*Date\.now\(\)/);
  });
});
