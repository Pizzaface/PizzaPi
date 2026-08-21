import { describe, expect, test } from "bun:test";
import { TunnelRelay } from "./server.js";

type Listener = (event?: unknown) => void;

function createMockWebSocket() {
  const sent: string[] = [];
  let closed = false;
  const listeners = new Map<string, Listener[]>();

  const ws = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {
      closed = true;
      for (const listener of listeners.get("close") ?? []) {
        listener();
      }
    },
    addEventListener(event: string, listener: Listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
  } as unknown as WebSocket;

  return {
    ws,
    sent,
    listeners,
    get closed() {
      return closed;
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}

async function waitForMicrotask(): Promise<void> {
  await Promise.resolve();
}

describe("TunnelRelay request-id collision cleanup", () => {
  test("request ids must not collide: a stale timer from an overwritten pending request must not delete the new request", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const eventsA: string[] = [];
    const eventsB: string[] = [];

    // Request A: short timeout so its timer fires while still "pending".
    relay.proxyHttpRequest(
      "r1",
      { id: "collision", port: 3000, method: "GET", url: "/a", headers: {} },
      {
        onResponseStart() {
          eventsA.push("start");
        },
        onResponseData() {
          eventsA.push("data");
        },
        onResponseEnd() {
          eventsA.push("end");
        },
        onError(error) {
          eventsA.push(`error:${error}`);
        },
      },
      5,
    );

    // Request B: same id, long timeout. This overwrites A in pendingRequests
    // but A's timer is still armed and references A's callbacks.
    relay.proxyHttpRequest(
      "r1",
      { id: "collision", port: 3000, method: "GET", url: "/b", headers: {} },
      {
        onResponseStart() {
          eventsB.push("start");
        },
        onResponseData() {
          eventsB.push("data");
        },
        onResponseEnd() {
          eventsB.push("end");
        },
        onError(error) {
          eventsB.push(`error:${error}`);
        },
      },
      60_000,
    );

    // Wait for A's stale timeout to fire.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A's timer should fire and report timeout to A's viewer only.
    expect(eventsA).toEqual(["error:Tunnel request timed out"]);

    // B's pending request should still be alive; A's leaked timer must not
    // have deleted it. Currently it does, so this assertion fails.
    mockWs.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "collision",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "text/plain" },
      }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "response-data", id: "collision", data: "body" }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "collision" }),
    });
    await waitForMicrotask();

    // B must receive its response in full despite sharing an id with A.
    expect(eventsB).toEqual(["start", "data", "end"]);

    relay.dispose();
  });
});
