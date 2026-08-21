import { describe, expect, test, jest, beforeEach, afterEach } from "bun:test";
import { TunnelRelay } from "./server.js";

type Listener = (event?: unknown) => void;

function createMockWebSocket() {
  const sent: string[] = [];
  let closed = false;
  let readyState = WebSocket.OPEN;
  const listeners = new Map<string, Listener[]>();

  const ws = {
    get readyState() {
      return readyState;
    },
    send(data: string) {
      sent.push(data);
    },
    close() {
      closed = true;
      readyState = WebSocket.CLOSED;
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

describe("TunnelRelay authorization", () => {
  test("static API key authorizes runner with a default userId", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mock = createMockWebSocket();

    relay.handleConnection(mock.ws);
    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    expect(relay.hasRunner("r1")).toBe(true);
    expect(JSON.parse(mock.sent[0])).toEqual({ type: "registered", runnerId: "r1" });
  });

  test("rejects invalid API key", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mock = createMockWebSocket();

    relay.handleConnection(mock.ws);
    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "wrong" }),
    });
    await waitForMicrotask();

    expect(mock.closed).toBe(true);
    expect(JSON.parse(mock.sent[0])).toEqual({ type: "error", message: "Invalid API key" });
    expect(relay.hasRunner("r1")).toBe(false);
  });

  test("rejects registration of same runnerId by a different user", async () => {
    const relay = new TunnelRelay({
      apiKeys: async (key) =>
        key === "user-a" ? "user-a" : key === "user-b" ? "user-b" : null,
    });

    const first = createMockWebSocket();
    relay.handleConnection(first.ws);
    first.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "user-a" }),
    });
    await waitForMicrotask();
    expect(relay.hasRunner("r1")).toBe(true);

    const second = createMockWebSocket();
    relay.handleConnection(second.ws);
    second.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "user-b" }),
    });
    await waitForMicrotask();

    expect(second.closed).toBe(true);
    expect(JSON.parse(second.sent[0])).toEqual({
      type: "error",
      message: "Runner already registered by another user",
    });
    expect(relay.hasRunner("r1")).toBe(true);
  });

  test("same user can re-register and evicts the old connection", async () => {
    const relay = new TunnelRelay({ apiKeys: async (key) => (key === "k" ? "user-a" : null) });

    const first = createMockWebSocket();
    relay.handleConnection(first.ws);
    first.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "k" }),
    });
    await waitForMicrotask();
    expect(first.closed).toBe(false);

    const second = createMockWebSocket();
    relay.handleConnection(second.ws);
    second.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "k" }),
    });
    await waitForMicrotask();

    expect(first.closed).toBe(true);
    expect(relay.hasRunner("r1")).toBe(true);
    expect(JSON.parse(second.sent[0])).toEqual({ type: "registered", runnerId: "r1" });
  });

  test("re-registration clears old pending callbacks without disconnecting the replacement", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const first = createMockWebSocket();
    const second = createMockWebSocket();
    relay.handleConnection(first.ws);
    relay.handleConnection(second.ws);

    first.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const oldEvents: string[] = [];
    const retryEvents: string[] = [];
    let retried = false;
    relay.proxyHttpRequest(
      "r1",
      { id: "old-http", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() { oldEvents.push("http-start"); },
        onResponseData() { oldEvents.push("http-data"); },
        onResponseEnd() { oldEvents.push("http-end"); },
        onError(error) {
          oldEvents.push(`http-error:${error}`);
          if (retried) return;
          retried = true;
          relay.proxyHttpRequest(
            "r1",
            { id: "retry-http", port: 3000, method: "GET", url: "/retry", headers: {} },
            {
              onResponseStart() { retryEvents.push("start"); },
              onResponseData() {},
              onResponseEnd() { retryEvents.push("end"); },
              onError(retryError) { retryEvents.push(`error:${retryError}`); },
            },
          );
        },
      },
    );
    relay.proxyWsOpen(
      "r1",
      { id: "old-ws", port: 3000, path: "/", headers: {} },
      {
        onOpened() { oldEvents.push("ws-opened"); },
        onData() { oldEvents.push("ws-data"); },
        onClose() { oldEvents.push("ws-close"); },
        onError(error) {
          oldEvents.push(`ws-error:${error}`);
          throw new Error("callback failure");
        },
      },
    );

    second.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    expect(oldEvents).toEqual(["http-error:Runner re-registered", "ws-error:Runner re-registered"]);
    expect(JSON.parse(second.sent[0])).toEqual({ type: "registered", runnerId: "r1" });
    expect(second.sent.some((message) => JSON.parse(message).id === "retry-http")).toBe(true);
    second.emit("message", { data: JSON.stringify({ type: "response-start", id: "retry-http", statusCode: 200, statusMessage: "OK", headers: {} }) });
    second.emit("message", { data: JSON.stringify({ type: "response-data-end", id: "retry-http" }) });
    await waitForMicrotask();
    expect(retryEvents).toEqual(["start", "end"]);

    second.emit("message", { data: JSON.stringify({ type: "response-data", id: "old-http", data: "stale" }) });
    second.emit("message", { data: JSON.stringify({ type: "ws-data", id: "old-ws", data: "stale" }) });
    await waitForMicrotask();
    expect(oldEvents).toEqual(["http-error:Runner re-registered", "ws-error:Runner re-registered"]);

    const newEvents: string[] = [];
    relay.proxyHttpRequest(
      "r1",
      { id: "new-http", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() { newEvents.push("start"); },
        onResponseData() {},
        onResponseEnd() { newEvents.push("end"); },
        onError(error) { newEvents.push(`error:${error}`); },
      },
    );
    first.emit("message", {
      data: JSON.stringify({ type: "response-start", id: "new-http", statusCode: 200, statusMessage: "OK", headers: {} }),
    });
    first.emit("message", { data: JSON.stringify({ type: "response-data-end", id: "new-http" }) });
    await waitForMicrotask();
    expect(newEvents).toEqual([]);

    first.emit("close");
    second.emit("message", {
      data: JSON.stringify({ type: "response-start", id: "new-http", statusCode: 200, statusMessage: "OK", headers: {} }),
    });
    second.emit("message", { data: JSON.stringify({ type: "response-data-end", id: "new-http" }) });
    await waitForMicrotask();

    expect(relay.getRunner("r1")).toBe(second.ws);
    expect(newEvents).toEqual(["start", "end"]);
    relay.dispose();
  });

  test("does not replace a runner when the registering socket closes during authorization", async () => {
    let authorizationCount = 0;
    let resolveReplacementAuthorization: (() => void) | undefined;
    const relay = new TunnelRelay({
      apiKeys: async () => {
        authorizationCount++;
        if (authorizationCount === 1) return "user-a";
        await new Promise<void>((resolve) => {
          resolveReplacementAuthorization = resolve;
        });
        return "user-a";
      },
    });
    const first = createMockWebSocket();
    const second = createMockWebSocket();
    relay.handleConnection(first.ws);
    relay.handleConnection(second.ws);

    first.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    second.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    second.ws.close();
    resolveReplacementAuthorization!();
    await waitForMicrotask();
    await waitForMicrotask();

    expect(first.closed).toBe(false);
    expect(relay.getRunner("r1")).toBe(first.ws);
    relay.dispose();
  });

  test("boolean authorize results still work for backwards compatibility", async () => {
    const relay = new TunnelRelay({ apiKeys: async (key) => key === "ok" });
    const mock = createMockWebSocket();

    relay.handleConnection(mock.ws);
    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "ok" }),
    });
    await waitForMicrotask();

    expect(relay.hasRunner("r1")).toBe(true);
  });
});

describe("TunnelRelay heartbeat", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("sends ping on interval and evicts stale runner after timeout", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mock = createMockWebSocket();

    relay.handleConnection(mock.ws);
    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    jest.advanceTimersByTime(30_000);
    await waitForMicrotask();
    expect(mock.sent.some((m) => JSON.parse(m).type === "ping")).toBe(true);

    jest.advanceTimersByTime(120_000);
    await waitForMicrotask();

    expect(mock.closed).toBe(true);
    expect(relay.hasRunner("r1")).toBe(false);

    relay.dispose();
  });

  test("pong refreshes liveness", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mock = createMockWebSocket();

    relay.handleConnection(mock.ws);
    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(30_000);
      mock.emit("message", { data: JSON.stringify({ type: "pong" }) });
      await waitForMicrotask();
    }

    expect(mock.closed).toBe(false);
    expect(relay.hasRunner("r1")).toBe(true);

    relay.dispose();
  });
});
