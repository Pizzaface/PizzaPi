import { describe, expect, test } from "bun:test";
import { TunnelClient } from "./client.js";

function attachMockRelay(client: TunnelClient) {
  const sent: string[] = [];
  (client as any).ws = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as WebSocket;
  return sent;
}

describe("TunnelClient request-id collision cleanup", () => {
  test("duplicate request-start overwrites the active request without aborting the old one", async () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    client.exposePort(3000);
    attachMockRelay(client);

    const firstReq = {
      write() {
        return true;
      },
      end() {
        return this;
      },
      destroyed: false,
      destroy() {
        this.destroyed = true;
        return this;
      },
    } as unknown as import("node:http").ClientRequest;

    const firstController = new AbortController();

    (client as any).activeRequests.set("collision", {
      controller: firstController,
      req: firstReq,
      bodyChunks: [],
      bodyBytes: 0,
      bodyEnded: false,
    });

    // A second request-start with the same id arrives before the first completes.
    (client as any).handleMessage(
      JSON.stringify({
        type: "request-start",
        id: "collision",
        port: 3000,
        method: "GET",
        url: "/second",
        headers: {},
      }),
    );

    const secondActive = (client as any).activeRequests.get("collision");
    expect(secondActive).toBeDefined();
    expect(secondActive.req).not.toBe(firstReq);

    // The first request should have been aborted/destroyed when overwritten, but
    // currently it is silently leaked.
    expect(firstController.signal.aborted).toBe(true);
    expect(firstReq.destroyed).toBe(true);
  });
});
