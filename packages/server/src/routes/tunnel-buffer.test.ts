import { describe, expect, test } from "bun:test";
import { TunnelRelay } from "@pizzapi/tunnel";
import { proxyTunnelRequestViaRelay } from "./tunnel.js";

type Listener = (event?: unknown) => void;

function createMockWebSocket() {
  const sent: string[] = [];
  let closed = false;
  let readyState: number = WebSocket.OPEN;
  const listeners = new Map<string, Listener[]>();

  const ws = {
    readyState,
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

async function createRegisteredRelay(apiKey = "test-key", runnerId = "r1") {
  const relay = new TunnelRelay({ apiKeys: [apiKey] });
  const mock = createMockWebSocket();
  relay.handleConnection(mock.ws);
  mock.emit("message", {
    data: JSON.stringify({ type: "register", runnerId, apiKey }),
  });
  await waitForMicrotask();
  return { relay, mock };
}

describe("proxyTunnelRequestViaRelay buffered response cap", () => {
  test("rejects upstream response with Content-Length exceeding cap", async () => {
    const { relay, mock } = await createRegisteredRelay();
    const req = new Request("http://example.com/api/tunnel/runner/r1/3000/", { method: "GET" });

    const responsePromise = proxyTunnelRequestViaRelay(
      req,
      relay,
      "r1",
      "req-cl",
      "/api/tunnel/runner/r1/3000",
      3000,
      "/",
      "/",
      {},
    );
    await waitForMicrotask();

    const requestStart = mock.sent.find((m) => JSON.parse(m).type === "request-start");
    expect(requestStart).toBeDefined();

    mock.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req-cl",
        statusCode: 200,
        statusMessage: "OK",
        headers: {
          "content-type": "text/html",
          "content-length": String(26 * 1024 * 1024),
        },
      }),
    });

    const response = await responsePromise;
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/too large/i);
  });

  test("aborts buffering when accumulated body chunks exceed cap", async () => {
    const { relay, mock } = await createRegisteredRelay();
    const req = new Request("http://example.com/api/tunnel/runner/r1/3000/", { method: "GET" });

    const responsePromise = proxyTunnelRequestViaRelay(
      req,
      relay,
      "r1",
      "req-chunks",
      "/api/tunnel/runner/r1/3000",
      3000,
      "/",
      "/",
      {},
    );
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req-chunks",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "text/html" },
      }),
    });
    await waitForMicrotask();

    const first = Buffer.alloc(24 * 1024 * 1024, "a");
    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-chunks",
        data: first.toString("binary"),
      }),
    });
    await waitForMicrotask();

    const second = Buffer.alloc(2 * 1024 * 1024, "b");
    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-chunks",
        data: second.toString("binary"),
      }),
    });

    const response = await responsePromise;
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/too large/i);

    const requestEnd = mock.sent.find((m) => JSON.parse(m).type === "request-end");
    expect(requestEnd).toBeDefined();
  });

  test("allows buffered responses just under the cap", async () => {
    const { relay, mock } = await createRegisteredRelay();
    const req = new Request("http://example.com/api/tunnel/runner/r1/3000/", { method: "GET" });

    const responsePromise = proxyTunnelRequestViaRelay(
      req,
      relay,
      "r1",
      "req-ok",
      "/api/tunnel/runner/r1/3000",
      3000,
      "/",
      "/",
      {},
    );
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req-ok",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "text/html" },
      }),
    });
    await waitForMicrotask();

    const body = Buffer.alloc(1024, "x");
    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-ok",
        data: body.toString("binary"),
      }),
    });
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req-ok" }),
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
  });
});
