import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane A2): exec_result cross-session bleed.
 *
 * `exec_result` is broadcast by the relay via broadcastToViewers(sessionId,
 * "exec_result", data) with no sessionId or generation stamp. Like the
 * disconnected event, it reaches the viewer through the old session room
 * during the async leave/join window of a logical session switch.
 *
 * App.tsx's exec_result handler currently only guards with awaitingSnapshot;
 * once the new session has received its "connected" header the gate opens, so a
 * stale exec_result from the previous session can set the status bar, clear
 * loading flags, or append a /rewind error to the wrong transcript.
 *
 * A correct filter must check the payload's sessionId or generation (requires
 * the server to stamp it) or suppress exec_results shortly after a switch.
 */
describe("exec_result stale-event filtering", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("exec_result handler rejects cross-session or untagged stale results", () => {
    const start = source.indexOf('nextSocket.on("exec_result"');
    const end = source.indexOf('nextSocket.on("disconnected"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toMatch(
      /matchesViewerGeneration|matchesViewerSession|data\.sessionId|data\.generation|recentSwitch|lastSwitchAt/,
    );
  });
});
