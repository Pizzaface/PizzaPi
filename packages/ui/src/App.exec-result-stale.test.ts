import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane A2): viewer stale-socket-event filtering.
 *
 * `exec_result` is a side-channel event that bypasses the sequenced `event`
 * envelope. The server broadcasts it without a generation or sessionId stamp
 * (relay/session-lifecycle.ts -> broadcastToViewers). App.tsx acknowledges the
 * risk in a comment but only guards with `awaitingSnapshot`, so once the new
 * session has finished hydrating a stale `exec_result` from the previous
 * session can still be processed.
 */
describe("exec_result stale-event filtering", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("exec_result handler filters by generation or recent-switch guard", () => {
    const start = source.indexOf('nextSocket.on("exec_result"');
    const end = source.indexOf('nextSocket.on("disconnected"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    // A correct filter must either compare data.generation against the
    // current switch generation or maintain a recent-switch timestamp window.
    expect(block).toMatch(
      /matchesViewerGeneration|data\.generation|generationRef\.current|lastSwitchAt|recentSwitch/,
    );
  });
});
