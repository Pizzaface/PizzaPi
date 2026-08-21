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

async function register(relay: TunnelRelay, mock: ReturnType<typeof createMockWebSocket>, runnerId: string) {
  relay.handleConnection(mock.ws);
  mock.emit("message", {
    data: JSON.stringify({ type: "register", runnerId, apiKey: "key1" }),
  });
  await waitForMicrotask();
}

describe("TunnelRelay cross-runner isolation", () => {
  test("a runner cannot inject an HTTP response into another runner's request", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const owner = createMockWebSocket();
    const attacker = createMockWebSocket();
    await register(relay, owner, "owner");
    await register(relay, attacker, "attacker");

    const events: string[] = [];
    relay.proxyHttpRequest(
      "owner",
      { id: "req1", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart(code) {
          events.push(`start:${code}`);
        },
        onResponseData() {
          events.push("data");
        },
        onResponseEnd() {
          events.push("end");
        },
        onError(error) {
          events.push(`error:${error}`);
        },
      },
    );

    // Attacker tries to inject a response for the owner's request.
    attacker.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req1",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "x-injected": "true" },
      }),
    });
    attacker.emit("message", {
      data: JSON.stringify({ type: "response-data", id: "req1", data: "evil" }),
    });
    attacker.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req1" }),
    });
    await waitForMicrotask();

    // No callbacks fired; the pending request is still intact for the owner.
    expect(events).toEqual([]);

    // The owner can still drive its own request to completion.
    owner.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req1",
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
      }),
    });
    owner.emit("message", {
      data: JSON.stringify({ type: "response-data", id: "req1", data: "good" }),
    });
    owner.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req1" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["start:200", "data", "end"]);
  });

  test("a runner cannot abort another runner's request", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const owner = createMockWebSocket();
    const attacker = createMockWebSocket();
    await register(relay, owner, "owner");
    await register(relay, attacker, "attacker");

    const events: string[] = [];
    relay.proxyHttpRequest(
      "owner",
      { id: "req1", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() {
          events.push("start");
        },
        onResponseData() {},
        onResponseEnd() {
          events.push("end");
        },
        onError(error) {
          events.push(`error:${error}`);
        },
      },
    );

    attacker.emit("message", {
      data: JSON.stringify({ type: "request-end", id: "req1" }),
    });
    await waitForMicrotask();

    expect(events).toEqual([]);

    // Owner still completes normally.
    owner.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req1",
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
      }),
    });
    owner.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req1" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["start", "end"]);
  });

  test("a runner cannot drive another runner's WebSocket proxy", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const owner = createMockWebSocket();
    const attacker = createMockWebSocket();
    await register(relay, owner, "owner");
    await register(relay, attacker, "attacker");

    const events: string[] = [];
    relay.proxyWsOpen(
      "owner",
      { id: "ws1", port: 8080, path: "/socket", headers: {} },
      {
        onOpened(protocol) {
          events.push(`opened:${protocol}`);
        },
        onData(data) {
          events.push(`data:${data}`);
        },
        onClose(code, reason) {
          events.push(`close:${code}:${reason}`);
        },
        onError(message) {
          events.push(`error:${message}`);
        },
      },
    );

    attacker.emit("message", {
      data: JSON.stringify({ type: "ws-opened", id: "ws1", protocol: "evil" }),
    });
    attacker.emit("message", {
      data: JSON.stringify({ type: "ws-data", id: "ws1", data: "evil", binary: false }),
    });
    attacker.emit("message", {
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1000, reason: "hijacked" }),
    });
    await waitForMicrotask();

    expect(events).toEqual([]);

    // Owner still drives its own ws to completion.
    owner.emit("message", {
      data: JSON.stringify({ type: "ws-opened", id: "ws1", protocol: "chat" }),
    });
    owner.emit("message", {
      data: JSON.stringify({ type: "ws-data", id: "ws1", data: "hello", binary: false }),
    });
    owner.emit("message", {
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1000, reason: "done" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["opened:chat", "data:hello", "close:1000:done"]);
  });

  test("a runner cannot error another runner's WebSocket proxy", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const owner = createMockWebSocket();
    const attacker = createMockWebSocket();
    await register(relay, owner, "owner");
    await register(relay, attacker, "attacker");

    const events: string[] = [];
    relay.proxyWsOpen(
      "owner",
      { id: "ws1", port: 8080, path: "/socket", headers: {} },
      {
        onOpened() {
          events.push("opened");
        },
        onData() {},
        onClose() {
          events.push("close");
        },
        onError(message) {
          events.push(`error:${message}`);
        },
      },
    );

    attacker.emit("message", {
      data: JSON.stringify({ type: "ws-error", id: "ws1", message: "hijacked" }),
    });
    await waitForMicrotask();

    expect(events).toEqual([]);

    // Owner still completes normally.
    owner.emit("message", {
      data: JSON.stringify({ type: "ws-opened", id: "ws1" }),
    });
    owner.emit("message", {
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1000, reason: "done" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["opened", "close"]);
  });
});
