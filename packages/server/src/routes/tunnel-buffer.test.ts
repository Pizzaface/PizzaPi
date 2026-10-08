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

  test("streams declared rewritable responses over sync-rewrite threshold byte-exact and unrewritten", async () => {
    const { relay, mock } = await createRegisteredRelay();
    const req = new Request("http://example.com/api/tunnel/runner/r1/3000/", { method: "GET" });

    const responsePromise = proxyTunnelRequestViaRelay(
      req,
      relay,
      "r1",
      "req-large-cl",
      "/api/tunnel/runner/r1/3000",
      3000,
      "/",
      "/",
      {},
    );
    await waitForMicrotask();

    const body = Buffer.concat([
      Buffer.from("<html><head></head><body>"),
      Buffer.alloc(3 * 1024 * 1024, "a"),
      Buffer.from("</body></html>"),
    ]);

    mock.emit("message", {
      data: JSON.stringify({
        type: "response-start",
        id: "req-large-cl",
        statusCode: 200,
        statusMessage: "OK",
        headers: {
          "content-type": "text/html",
          "content-length": String(body.length),
        },
      }),
    });
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-large-cl",
        data: body.toString("binary"),
      }),
    });
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req-large-cl" }),
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.equals(body)).toBe(true);
    expect(received.includes("<base")).toBe(false);
    expect(response.headers.get("x-pizzapi-rewrite")).toBe("skipped-size");
  });

  test("rejects accumulated rewritable responses over the hard buffer cap", async () => {
    const { relay, mock } = await createRegisteredRelay();
    const req = new Request("http://example.com/api/tunnel/runner/r1/3000/", { method: "GET" });

    const responsePromise = proxyTunnelRequestViaRelay(
      req,
      relay,
      "r1",
      "req-too-large-chunk",
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
        id: "req-too-large-chunk",
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "text/html" },
      }),
    });
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-too-large-chunk",
        data: Buffer.alloc(26 * 1024 * 1024, "x").toString("binary"),
      }),
    });

    const response = await responsePromise;
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/too large/i);
  });

  test("falls back to unrewritten streaming once the buffered body exceeds the sync-rewrite threshold", async () => {
    // Regression test for the event-loop-blocking bug: a rewritable (HTML)
    // response whose size isn't known up front (chunked, no Content-Length)
    // must stop buffering for the synchronous multi-pass regex rewrite once
    // it grows past TUNNEL_SYNC_REWRITE_MAX_BYTES, and stream the rest through
    // byte-for-byte instead — proven here by the absence of the <base> tag
    // the rewrite would otherwise inject.
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
        headers: { "content-type": "text/html" }, // no content-length: chunked transfer
      }),
    });
    await waitForMicrotask();

    // Stays under the 2 MiB sync-rewrite budget on its own. Contains a <head>
    // tag that a rewrite pass would inject a <base> tag right after.
    const first = Buffer.concat([Buffer.from("<html><head></head><body>"), Buffer.alloc(1024 * 1024, "a")]);
    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-chunks",
        data: first.toString("binary"),
      }),
    });
    await waitForMicrotask();

    // Pushes the accumulated body past the threshold mid-response.
    const second = Buffer.alloc(2 * 1024 * 1024, "b");
    mock.emit("message", {
      data: JSON.stringify({
        type: "response-data",
        id: "req-chunks",
        data: second.toString("binary"),
      }),
    });
    await waitForMicrotask();

    mock.emit("message", {
      data: JSON.stringify({ type: "response-data-end", id: "req-chunks" }),
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-pizzapi-rewrite")).toBe("skipped-size");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(Buffer.concat([first, second]))).toBe(true);
    expect(body.includes("<base")).toBe(false);
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
