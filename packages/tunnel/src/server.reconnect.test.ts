import { describe, expect, test } from "bun:test";
import { TunnelRelay } from "./server.js";

type Listener = (event?: unknown) => void;

function waitForMicrotask(): Promise<void> {
  return Promise.resolve();
}

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

describe("TunnelRelay runner re-registration cleanup", () => {
  test("re-registration with a new socket leaks stale pending requests and WebSockets", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const oldWs = createMockWebSocket();
    const newWs = createMockWebSocket();

    relay.handleConnection(oldWs.ws);
    oldWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    relay.proxyHttpRequest(
      "r1",
      { id: "req1", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() {},
        onError() {},
      },
    );

    relay.proxyWsOpen(
      "r1",
      { id: "ws1", port: 8080, path: "/socket", headers: {} },
      {
        onOpened() {},
        onData() {},
        onClose() {},
        onError() {},
      },
    );

    expect((relay as any).pendingRequests.size).toBe(1);
    expect((relay as any).pendingWs.size).toBe(1);

    // Re-register the same runnerId over a fresh socket.
    relay.handleConnection(newWs.ws);
    newWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    expect(oldWs.closed).toBe(true);
    // Pending entries from the old connection should have been cleaned up.
    expect((relay as any).pendingRequests.size).toBe(0);
    expect((relay as any).pendingWs.size).toBe(0);
  });

  test("stale pending entries are routed to the old callbacks from the new socket", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const oldWs = createMockWebSocket();
    const newWs = createMockWebSocket();

    relay.handleConnection(oldWs.ws);
    oldWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const callbacks = {
      onResponseStart: () => {},
      onResponseDataCalls: 0,
      onResponseEnd: () => {},
      onError: () => {},
    };

    relay.proxyHttpRequest(
      "r1",
      { id: "req1", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() { callbacks.onResponseStart(); },
        onResponseData() { callbacks.onResponseDataCalls++; },
        onResponseEnd() { callbacks.onResponseEnd(); },
        onError() { callbacks.onError(); },
      },
    );

    relay.handleConnection(newWs.ws);
    newWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    // The new runner sends a response for an id that was pending on the dead socket.
    newWs.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req1",
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
      }),
    });
    newWs.emit("message", {
      data: JSON.stringify({ type: "response-data", id: "req1", data: "leaked" }),
    });
    newWs.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req1" }),
    });
    await waitForMicrotask();

    expect(callbacks.onResponseDataCalls).toBe(0);
  });
});
