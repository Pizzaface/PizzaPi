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

describe("TunnelRelay close-during-auth race", () => {
  test("socket closes during auth await → runner NOT registered (no ghost)", async () => {
    // Auth resolves after a microtask so we can close the socket in between.
    let resolveAuth!: (v: string) => void;
    const authPromise = new Promise<string>((res) => (resolveAuth = res));

    const relay = new TunnelRelay({
      apiKeys: async (_key: string, _runnerId: string) => authPromise,
    });
    const mockWs = createMockWebSocket();
    relay.handleConnection(mockWs.ws);

    // Trigger registration — auth will suspend.
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "ghost-runner", apiKey: "valid" }),
    });

    // Simulate socket close before auth resolves.
    (mockWs.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSING;

    // Now resolve auth — registration should be aborted.
    resolveAuth("user-1");
    for (let i = 0; i < 5; i++) await waitForMicrotask();

    expect(relay.hasRunner("ghost-runner")).toBe(false);
  });

  test("existing runner preserved when NEW socket closes during auth (D-006 P1 regression)", async () => {
    // Auth call 1: resolves immediately (for stable first-registration).
    // Auth call 2: suspends until we decide (for the re-registration attempt).
    let resolveSecondAuth!: (v: string) => void;
    const secondAuthPromise = new Promise<string>((res) => (resolveSecondAuth = res));
    let callCount = 0;
    const relay = new TunnelRelay({
      apiKeys: async () => {
        callCount++;
        return callCount === 1 ? "user-1" : secondAuthPromise;
      },
    });

    // Register the stable existing runner.
    const existingWs = createMockWebSocket();
    relay.handleConnection(existingWs.ws);
    existingWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "shared-runner", apiKey: "valid" }),
    });
    for (let i = 0; i < 5; i++) await waitForMicrotask();
    expect(relay.hasRunner("shared-runner")).toBe(true);

    // New socket tries to re-register the same runner — auth suspends.
    const newWs = createMockWebSocket();
    relay.handleConnection(newWs.ws);
    newWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "shared-runner", apiKey: "valid" }),
    });

    // Close the new socket before auth resolves.
    (newWs.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSING;

    // Resolve auth — guard must abort WITHOUT tearing down the existing runner.
    resolveSecondAuth("user-1");
    for (let i = 0; i < 5; i++) await waitForMicrotask();

    expect(relay.hasRunner("shared-runner")).toBe(true); // existing runner intact
    relay.dispose();
  });

  test("socket stays open during auth → registers normally", async () => {
    let resolveAuth!: (v: string) => void;
    const authPromise = new Promise<string>((res) => (resolveAuth = res));

    const relay = new TunnelRelay({
      apiKeys: async (_key: string, _runnerId: string) => authPromise,
    });
    const mockWs = createMockWebSocket();
    relay.handleConnection(mockWs.ws);

    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "good-runner", apiKey: "valid" }),
    });

    // Socket stays OPEN — normal path. Need several microtask flushes:
    // authPromise resolves → async-fn wrapper tick → handleRegister resumes → handleMessage resumes.
    resolveAuth("user-1");
    for (let i = 0; i < 5; i++) await waitForMicrotask();

    expect(relay.hasRunner("good-runner")).toBe(true);
    relay.dispose();
  });
});

describe("TunnelRelay WebSocket proxy callbacks", () => {
  test("viewer close releases pending state and settles callbacks without waiting for an ack", async () => {
    const relay = new TunnelRelay({ apiKeys: ["key1"] });
    const mockWs = createMockWebSocket();
    const pendingWs = Reflect.get(relay, "pendingWs") as Map<string, unknown>;

    relay.handleConnection(mockWs.ws);
    mockWs.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "r1", apiKey: "key1" }),
    });
    await waitForMicrotask();

    const events: string[] = [];
    relay.proxyWsOpen(
      "r1",
      { id: "ws1", port: 8080, path: "/socket", headers: {} },
      {
        onOpened() {},
        onData() {},
        onClose(code, reason) {
          events.push(`close:${code}:${reason}`);
        },
        onError(message) {
          events.push(`error:${message}`);
        },
      },
    );

    expect(pendingWs.size).toBe(1);

    relay.sendWsClose("r1", "ws1", 1000, "viewer closed");

    expect(pendingWs.size).toBe(0);
    expect(events).toEqual(["close:1000:viewer closed"]);
    expect(JSON.parse(mockWs.sent.at(-1)!)).toEqual({
      type: "ws-close",
      id: "ws1",
      code: 1000,
      reason: "viewer closed",
    });

    const sentBeforeSecondClose = mockWs.sent.length;
    relay.sendWsClose("r1", "ws1", 1000, "viewer closed");
    expect(events).toEqual(["close:1000:viewer closed"]);
    expect(mockWs.sent).toHaveLength(sentBeforeSecondClose);
  });

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
      data: JSON.stringify({ type: "ws-close", id: "ws1", code: 1000, reason: "done" }),
    });
    await waitForMicrotask();

    expect(events).toEqual(["opened:chat", "data:hello:text", "close:1000:done"]);
  });
});
