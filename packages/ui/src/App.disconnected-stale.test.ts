import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane A2): viewer stale-socket-event filtering.
 *
 * `disconnected` is broadcast to the session room by endSharedSession() without
 * a sessionId or generation stamp. During a logical session switch the viewer
 * socket leaves the old room asynchronously; a stale disconnect from the
 * previous session can still be in flight. App.tsx's disconnected handler only
 * checks generation, and an untagged payload passes matchesViewerGeneration(),
 * so it tears down the *new* session as if the current one ended.
 *
 * A correct filter must either check the payload's sessionId (requires the
 * server to stamp it) or suppress untagged disconnects shortly after a switch.
 */
describe("disconnected stale-event filtering", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("disconnected handler rejects cross-session or untagged stale disconnects", () => {
    const start = source.indexOf('nextSocket.on("disconnected"');
    const end = source.indexOf('nextSocket.on("error"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toMatch(
      /matchesViewerSession|data\.sessionId|lastSwitchAt|recentSwitch/,
    );
  });
});
