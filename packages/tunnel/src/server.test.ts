import { Buffer } from "node:buffer";
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

describe("TunnelRelay", () => {
  test("can be instantiated with API keys", () => {
    const relay = new TunnelRelay({ apiKeys: ["test-key"] });
    expect(relay).toBeDefined();
    expect(relay.getRunner("nonexistent")).toBeUndefined();
  });

  test("rejects empty API keys array", () => {
    expect(() => new TunnelRelay({ apiKeys: [] })).toThrow();
  });

  test("accepts async API key validators", async () => {
    const relay = new TunnelRelay({
      apiKeys: async (key) => key === "validated-key",
    });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "runner-1", apiKey: "validated-key" }),
    });
    await waitForMicrotask();

    expect(relay.hasRunner("runner-1")).toBe(true);
    expect(JSON.parse(mockWs.sent[0]).type).toBe("registered");
  });
});

describe("TunnelRelay message handling", () => {
  test("drops malformed frames and continues handling valid frames", async () => {
    const warnings: unknown[][] = [];
    const relay = new TunnelRelay({
      apiKeys: ["key1"],
      log: { info() {}, debug() {}, error() {}, warn(...args) { warnings.push(args); } },
    });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", { data: JSON.stringify({ type: "response-data", id: "req1" }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "unknown", id: "req1" }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "ws-close", id: 1, code: "1000" }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "response-start", id: "req1", statusCode: 0, statusMessage: "", headers: {} }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1001 }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "ws-close", id: "ws1", code: 999 }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "ws-close", id: "ws1", code: 5000 }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1000.5 }) });
    mockWs.emit("message", { data: JSON.stringify({ type: "ws-close", id: "ws1", reason: "x".repeat(124) }) });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    expect(warnings).toHaveLength(8);
    expect(relay.hasRunner("r1")).toBe(true);
  });

  test("catches handler failures without an unhandled rejection", async () => {
    const errors: unknown[][] = [];
    const relay = new TunnelRelay({
      apiKeys: ["key1"],
      log: { info() {}, debug() {}, warn() {}, error(...args) { errors.push(args); } },
    });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();
    relay.proxyHttpRequest(
      "r1",
      { id: "req1", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() {},
        onResponseData() { throw new Error("callback failed"); },
        onResponseEnd() {},
        onError() {},
      },
    );
    mockWs.emit("message", { data: JSON.stringify({ type: "response-data", id: "req1", data: "body" }) });
    await waitForMicrotask();
    await waitForMicrotask();

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe("[tunnel-relay] Failed to handle client message:");
  });

  test("handleConnection registers a runner", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    expect(mockWs.sent.length).toBe(1);
    expect(JSON.parse(mockWs.sent[0])).toEqual({ type: "registered", runnerId: "r1" });
    expect(relay.hasRunner("r1")).toBe(true);
  });

  test("rejects invalid API key", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "wrong" }),
    });
    await waitForMicrotask();

    expect(mockWs.closed).toBe(true);
    expect(JSON.parse(mockWs.sent[0])).toEqual({ type: "error", message: "Invalid API key" });
    expect(relay.hasRunner("r1")).toBe(false);
  });
});

describe("TunnelRelay HTTP proxy callbacks", () => {
  test("proxyHttpRequest returns error when runner not connected", () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    let errorMessage = "";

    relay.proxyHttpRequest(
      "missing",
      { id: "req1", port: 3000, method: "GET", url: "/", headers: {} },
      {
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() {},
        onError(error) {
          errorMessage = error;
        },
      },
    );

    expect(errorMessage).toContain("not connected");
  });

  test("response callbacks fire in order", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const events: string[] = [];
    let statusCode = 0;
    let body = Buffer.alloc(0);

    relay.proxyHttpRequest(
      "r1",
      { id: "req1", port: 3000, method: "GET", url: "/test", headers: {} },
      {
        onResponseStart(code) {
          events.push("start");
          statusCode = code;
        },
        onResponseData(chunk) {
          events.push("data");
          body = Buffer.concat([body, chunk]);
        },
        onResponseEnd() {
          events.push("end");
        },
        onError() {
          events.push("error");
        },
      },
    );

    expect(JSON.parse(mockWs.sent[1])).toMatchObject({
      type: "request-start",
      id: "req1",
      port: 3000,
      method: "GET",
      url: "/test",
    });

    mockWs.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req1",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "text/plain" },
      }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "response-data", id: "req1", data: "hello" }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req1" }),
    });

    await waitForMicrotask();

    expect(events).toEqual(["start", "data", "end"]);
    expect(statusCode).toBe(200);
    expect(body.toString("binary")).toBe("hello");
  });

  test("times out when the runner never starts a response", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const errors: string[] = [];
    relay.proxyHttpRequest(
      "r1",
      { id: "req-timeout", port: 3000, method: "GET", url: "/events", headers: {} },
      {
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() {},
        onError(error) {
          errors.push(error);
        },
      },
      5,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toEqual(["Tunnel request timed out"]);
    expect(JSON.parse(mockWs.sent.at(-1)!)).toMatchObject({ type: "request-end", id: "req-timeout" });
  });

  test("does not time out long-lived streams after response headers arrive", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const events: string[] = [];
    relay.proxyHttpRequest(
      "r1",
      { id: "req-stream", port: 3000, method: "GET", url: "/events", headers: {} },
      {
        onResponseStart() {
          events.push("start");
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
      5,
    );

    mockWs.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req-stream",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "text/event-stream" },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    mockWs.emit("message", {
      data: JSON.stringify({ type: "response-data", id: "req-stream", data: "event: ping\\n\\n" }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req-stream" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["start", "data", "end"]);
  });

  test("disconnect only fails requests for the matching runner", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const runnerA = createMockWebSocket();
    const runnerB = createMockWebSocket();

    relay.handleConnection(runnerA.ws);
    relay.handleConnection(runnerB.ws);

    runnerA.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "runner-a", apiKey: "key1" }),
    });
    runnerB.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "runner-b", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const errors: string[] = [];

    relay.proxyHttpRequest(
      "runner-a",
      { id: "req-a", port: 3000, method: "GET", url: "/a", headers: {} },
      {
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() {},
        onError(error) {
          errors.push(`a:${error}`);
        },
      },
    );

    relay.proxyHttpRequest(
      "runner-b",
      { id: "req-b", port: 3001, method: "GET", url: "/b", headers: {} },
      {
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() {},
        onError(error) {
          errors.push(`b:${error}`);
        },
      },
    );

    runnerA.ws.close();
    await waitForMicrotask();

    expect(errors).toEqual(["a:Runner disconnected"]);

    runnerB.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req-b",
        statusCode: 204,
        statusMessage: "No Content",
        headers: {},
      }),
    });
    runnerB.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req-b" }),
    });
    await waitForMicrotask();

    expect(errors).toEqual(["a:Runner disconnected"]);
  });
});

describe("TunnelRelay WebSocket proxy callbacks", () => {
  test("ws-opened, ws-data, and ws-close route to callbacks", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const events: string[] = [];
    relay.proxyWsOpen(
      "r1",
      { id: "ws1", port: 8080, path: "/socket", protocols: ["chat"], headers: {} },
      {
        onOpened(protocol) {
          events.push(`opened:${protocol}`);
        },
        onData(data, binary) {
          events.push(`data:${data}:${binary ? "binary" : "text"}`);
        },
        onClose(code, reason) {
          events.push(`close:${code}:${reason}`);
        },
        onError(message) {
          events.push(`error:${message}`);
        },
      },
    );

    expect(JSON.parse(mockWs.sent[1])).toMatchObject({
      type: "ws-open",
      id: "ws1",
      port: 8080,
      path: "/socket",
    });

    mockWs.emit("message", {
      data: JSON.stringify({ type: "ws-opened", id: "ws1", protocol: "chat" }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "ws-data", id: "ws1", data: "hello", binary: false }),
    });
    mockWs.emit("message", {
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1001, reason: "done" }),
    });
    relay.proxyWsOpen(
      "r1",
      { id: "ws1", port: 8080, path: "/socket", protocols: ["chat"], headers: {} },
      {
        onOpened() {},
        onData() {},
        onClose(code, reason) { events.push(`close:${code}:${reason}`); },
        onError() {},
      },
    );
    mockWs.emit("message", {
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1011, reason: "failed" }),
    });
    relay.proxyWsOpen(
      "r1",
      { id: "ws1", port: 8080, path: "/socket", protocols: ["chat"], headers: {} },
      {
        onOpened() {},
        onData() {},
        onClose(code, reason) { events.push(`close:${code}:${reason}`); },
        onError() {},
      },
    );
    mockWs.emit("message", {
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1006, reason: "abnormal" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["opened:chat", "data:hello:text", "close:1000:done", "close:1000:failed", "close:1000:abnormal"]);
  });
});
