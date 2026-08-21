import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane A2): service_message tunnel_registered cross-session bleed.
 *
 * `service_message` events from the runner are broadcast into the per-session
 * viewer room by `broadcastToSessionViewers(targetSessionId, "service_message", envelope)`
 * with no sessionId or generation stamp added by the server. Like `exec_result`
 * and `disconnected`, a stale envelope from the previous session can reach the
 * viewer socket during the async leave/join window of a logical session switch.
 *
 * App.tsx's `service_message` handler for `tunnel_registered` auto-opens the
 * Tunnel panel but does not check `envelope.sessionId` or the viewer generation.
 * Because the payload may omit sessionId entirely, the handler must either
 * ignore untagged tunnel registrations shortly after a switch or require the
 * server to stamp the envelope.
 */
describe("service_message tunnel_registered stale-event filtering", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("tunnel_registered service_message handler rejects cross-session or untagged stale messages", () => {
    const start = source.indexOf("const handler = (envelope: { serviceId: string; type: string; payload: unknown })");
    const end = source.indexOf('viewerSocket.off("service_message", handler);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toMatch(
      /matchesViewerGeneration|matchesViewerSession|envelope\.sessionId|data\.sessionId|generation|recentSwitch|lastSwitchAt/,
    );
  });
});
