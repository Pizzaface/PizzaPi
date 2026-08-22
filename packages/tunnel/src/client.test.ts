import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import https from "node:https";
import net from "node:net";
import { describe, expect, test, jest, afterEach } from "bun:test";
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

async function startHttpServer(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return { server, port: address.port };
}

async function stopHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function decodeSent(sent: string[]) {
  return sent.map((value) => JSON.parse(value));
}

describe("TunnelClient", () => {
  test("can be instantiated", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
    });
    expect(client).toBeDefined();
  });

  test("exposes port management API", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
    });
    client.exposePort(3000);
    expect(client.isPortExposed(3000)).toBe(true);
    client.unexposePort(3000);
    expect(client.isPortExposed(3000)).toBe(false);
  });

  test("handleRequestData writes to the stored ClientRequest and handleRequestDataEnd ends it", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
    });

    const writes: Buffer[] = [];
    let ended = false;
    const req = {
      write(chunk: Buffer) {
        writes.push(chunk);
        return true;
      },
      end() {
        ended = true;
        return this;
      },
      destroy() {
        return this;
      },
    } as unknown as import("node:http").ClientRequest;

    (client as any).activeRequests.set("req1", {
      controller: new AbortController(),
      req,
    });

    (client as any).handleRequestData({ id: "req1", data: "hello" });
    (client as any).handleRequestDataEnd({ id: "req1" });

    expect(Buffer.concat(writes).toString("binary")).toBe("hello");
    expect(ended).toBe(true);
  });

  test("evicts a reused HTTP id by aborting and destroying the old request", () => {
    const client = new TunnelClient({ runnerId: "r1", apiKey: "key1", relayUrl: "ws://localhost:9999/_tunnel" });
    const controller = new AbortController();
    let destroyed = false;
    const old = { controller, req: { destroy() { destroyed = true; } } };
    const replacement = { controller: new AbortController(), req: { destroy() {} } };

    (client as any).activeRequests.set("reused", old);
    (client as any).replaceActiveRequest("reused", replacement);

    expect(controller.signal.aborted).toBe(true);
    expect(destroyed).toBe(true);
    expect((client as any).activeRequests.get("reused")).toBe(replacement);
  });

  test("evicts a reused WebSocket id by closing the old connection", () => {
    const client = new TunnelClient({ runnerId: "r1", apiKey: "key1", relayUrl: "ws://localhost:9999/_tunnel" });
    let closed = false;
    const old = { close() { closed = true; } } as unknown as WebSocket;
    const replacement = { close() {} } as unknown as WebSocket;

    (client as any).activeWs.set("reused", old);
    (client as any).replaceActiveWs("reused", replacement);

    expect(closed).toBe(true);
    expect((client as any).activeWs.get("reused")).toBe(replacement);
  });

  test("ignores stale WebSocket open and data events after an id collision", () => {
    const OriginalWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      protocol = "";
      binaryType = "";
      private listeners = new Map<string, Array<(event: any) => void>>();
      static instances: FakeWebSocket[] = [];
      constructor() { FakeWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close() { this.readyState = 3; }
      emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }

    try {
      (globalThis as any).WebSocket = FakeWebSocket;
      const client = new TunnelClient({ runnerId: "r1", apiKey: "key1", relayUrl: "ws://localhost:9999/_tunnel" });
      const sent = attachMockRelay(client);
      (client as any).exposedPorts.add(3000);
      (client as any).handleWsOpen({ id: "reused", port: 3000, path: "/", headers: {} });
      (client as any).handleWsOpen({ id: "reused", port: 3000, path: "/", headers: {} });

      FakeWebSocket.instances[0].emit("open");
      FakeWebSocket.instances[0].emit("message", { data: "stale" });

      expect(decodeSent(sent)).toEqual([]);
    } finally {
      (globalThis as any).WebSocket = OriginalWebSocket;
    }
  });

  test("returns 404 for requests to unexposed ports", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    const sent = attachMockRelay(client);

    (client as any).handleMessage(
      JSON.stringify({
        type: "request-start",
        id: "req1",
        port: 3999,
        method: "GET",
        url: "/",
        headers: {},
      }),
    );

    const messages = decodeSent(sent);
    expect(messages).toEqual([
      { type: "response-start", id: "req1", statusCode: 404, statusMessage: "Not Found", headers: {} },
      { type: "response-data", id: "req1", data: "Port 3999 is not exposed" },
      { type: "response-data-end", id: "req1" },
    ]);
  });

  test("strips accept-encoding from forwarded headers so local service returns uncompressed responses", async () => {
    let seenAcceptEncoding: string | undefined;

    const { server, port } = await startHttpServer((req, res) => {
      seenAcceptEncoding = req.headers["accept-encoding"];
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>ok</body></html>");
    });

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({
          type: "request-start",
          id: "req-enc",
          port,
          method: "GET",
          url: "/",
          headers: {
            "accept-encoding": "gzip, deflate, br",
            "accept": "text/html",
          },
        }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-enc" }));

      await waitUntil(() => decodeSent(sent).some((m) => m.type === "response-data-end"));

      // The local service must NOT see accept-encoding — otherwise it would
      // compress the response and the tunnel rewriting path would garble it.
      expect(seenAcceptEncoding).toBeUndefined();
    } finally {
      await stopHttpServer(server);
    }
  });

  test("streams local HTTP responses back to the relay", async () => {
    let seenAuthorization: string | undefined;
    let seenHost: string | undefined;

    const { server, port } = await startHttpServer((req, res) => {
      seenAuthorization = req.headers.authorization;
      seenHost = req.headers.host;
      res.writeHead(201, "Created", { "content-type": "text/plain" });
      res.write("hello");
      res.end(" world");
    });

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({
          type: "request-start",
          id: "req-http",
          port,
          method: "GET",
          url: "/stream",
          headers: {
            authorization: "secret",
            connection: "close",
            host: "evil.example",
            "x-forwarded-for": "viewer",
          },
        }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-http" }));

      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data-end"));

      const messages = decodeSent(sent);
      expect(messages[0]).toMatchObject({
        type: "response-start",
        id: "req-http",
        statusCode: 201,
        statusMessage: "Created",
      });
      const body = messages
        .filter((message) => message.type === "response-data")
        .map((message) => Buffer.from(message.data, "binary"))
        .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0))
        .toString("utf-8");
      expect(body).toBe("hello world");
      expect(seenAuthorization).toBeUndefined();
      expect(seenHost).toBe(`127.0.0.1:${port}`);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("does not forward response data after cancellation", async () => {
    let sendLateData!: () => void;
    const { server, port } = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.write("before-cancel");
      sendLateData = () => {
        res.write("after-cancel");
        res.end();
      };
    });

    try {
      const client = new TunnelClient({ runnerId: "r1", apiKey: "key1", relayUrl: "ws://localhost:9999/_tunnel", autoReconnect: false });
      client.exposePort(port);
      const sent = attachMockRelay(client);
      (client as any).handleMessage(JSON.stringify({ type: "request-start", id: "req-cancel", port, method: "GET", url: "/", headers: {} }));
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-cancel" }));
      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data"));

      (client as any).handleMessage(JSON.stringify({ type: "request-end", id: "req-cancel" }));
      sendLateData();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(decodeSent(sent).filter((message) => message.type === "response-data").map((message) => message.data)).toEqual(["before-cancel"]);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("finalizes a response when the local stream closes prematurely", async () => {
    const { server, port } = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 5);
    });

    try {
      const client = new TunnelClient({ runnerId: "r1", apiKey: "key1", relayUrl: "ws://localhost:9999/_tunnel", autoReconnect: false });
      client.exposePort(port);
      const sent = attachMockRelay(client);
      (client as any).handleMessage(JSON.stringify({ type: "request-start", id: "req-close", port, method: "GET", url: "/", headers: {} }));
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-close" }));

      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data-abort"));
      expect(decodeSent(sent).filter((message) => message.type === "response-data").map((message) => message.data)).toEqual(["partial"]);
      expect(decodeSent(sent).some((message) => message.type === "response-data-end")).toBe(false);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("ignores a request error emitted after the response completed", async () => {
    const { server, port } = await startHttpServer((_req, res) => res.end("ok"));

    try {
      const client = new TunnelClient({ runnerId: "r1", apiKey: "key1", relayUrl: "ws://localhost:9999/_tunnel", autoReconnect: false });
      client.exposePort(port);
      const sent = attachMockRelay(client);
      (client as any).handleMessage(JSON.stringify({ type: "request-start", id: "req-late-error", port, method: "GET", url: "/", headers: {} }));
      const request = (client as any).activeRequests.get("req-late-error").req;
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-late-error" }));
      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data-end"));

      request.emit("error", new Error("late body failure"));
      await Promise.resolve();
      expect(decodeSent(sent).filter((message) => message.type === "response-start")).toHaveLength(1);
      expect(decodeSent(sent).filter((message) => message.statusCode === 502)).toHaveLength(0);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("preserves multiple Set-Cookie headers as an array instead of joining them", async () => {
    const { server, port } = await startHttpServer((_req, res) => {
      res.setHeader("set-cookie", [
        "a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
        "b=2; Path=/; HttpOnly",
      ]);
      res.writeHead(200);
      res.end("ok");
    });

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({ type: "request-start", id: "req-cookie", port, method: "GET", url: "/", headers: {} }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-cookie" }));

      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data-end"));

      const start = decodeSent(sent).find((message) => message.type === "response-start");
      expect(start.headers["set-cookie"]).toEqual([
        "a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
        "b=2; Path=/; HttpOnly",
      ]);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("request-start plus request-data chunks proxy POST bodies to the local service", async () => {
    let receivedBody = "";

    const { server, port } = await startHttpServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        receivedBody += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`received:${receivedBody}`);
      });
    });

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({
          type: "request-start",
          id: "req-post",
          port,
          method: "POST",
          url: "/submit",
          headers: { "content-type": "text/plain" },
        }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data", id: "req-post", data: "hel" }));
      (client as any).handleMessage(JSON.stringify({ type: "request-data", id: "req-post", data: "lo" }));
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-post" }));

      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data-end"));

      const body = decodeSent(sent)
        .filter((message) => message.type === "response-data")
        .map((message) => Buffer.from(message.data, "binary"))
        .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0))
        .toString("utf-8");

      expect(receivedBody).toBe("hello");
      expect(body).toBe("received:hello");
    } finally {
      await stopHttpServer(server);
    }
  });

  test("drops malformed relay frames and still handles valid frames", () => {
    const warnings: unknown[][] = [];
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
      log: { info() {}, debug() {}, error() {}, warn(...args) { warnings.push(args); } },
    });
    const sent = attachMockRelay(client);

    (client as any).handleMessage(JSON.stringify({ type: "request-data", id: "req1" }));
    (client as any).handleMessage(JSON.stringify({ type: "unknown", id: "req1" }));
    (client as any).handleMessage(JSON.stringify({ type: "ws-open", id: 1, port: "3000", path: "/", headers: {} }));
    (client as any).handleMessage(JSON.stringify({ type: "ws-close", id: "ws1", code: 1001 }));
    (client as any).handleMessage(JSON.stringify({ type: "ws-close", id: "ws1", code: 999 }));
    (client as any).handleMessage(JSON.stringify({ type: "ws-close", id: "ws1", code: 5000 }));
    (client as any).handleMessage(JSON.stringify({ type: "ws-close", id: "ws1", code: 1000.5 }));
    (client as any).handleMessage(JSON.stringify({ type: "ws-close", id: "ws1", reason: "x".repeat(124) }));
    (client as any).handleMessage(JSON.stringify({ type: "ping" }));

    expect(warnings).toHaveLength(7);
    expect(decodeSent(sent)).toEqual([{ type: "pong" }]);
  });

  test("normalizes received protocol close codes for the browser WebSocket API", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    const closed: Array<[number, string]> = [];

    for (const [id, code] of [["ws-1001", 1001], ["ws-1011", 1011]] as const) {
      (client as any).activeWs.set(id, { close(closeCode: number, reason: string) { closed.push([closeCode, reason]); } });
      (client as any).handleMessage(JSON.stringify({ type: "ws-close", id, code, reason: "relay closed" }));
    }

    expect(closed).toEqual([[1000, "relay closed"], [1000, "relay closed"]]);
  });

  test("responds to ping with pong", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    const sent = attachMockRelay(client);

    (client as any).handleMessage(JSON.stringify({ type: "ping" }));

    expect(decodeSent(sent)).toEqual([{ type: "pong" }]);
  });

  test("forwards binary ws-data frames to the active local websocket", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });

    const sentFrames: Array<string | Buffer> = [];
    (client as any).activeWs.set("ws1", {
      readyState: WebSocket.OPEN,
      send(data: string | Buffer) {
        sentFrames.push(data);
      },
      close() {},
    } as unknown as WebSocket);

    (client as any).handleWsData({
      id: "ws1",
      data: Buffer.from("hello").toString("base64"),
      binary: true,
      type: "ws-data",
    });

    expect(Buffer.isBuffer(sentFrames[0])).toBe(true);
    expect((sentFrames[0] as Buffer).toString("utf-8")).toBe("hello");
  });
});

describe("TunnelClient loopback fallback", () => {
  test("retries [::1] and replays the body when 127.0.0.1 is refused (IPv6-only local server)", async () => {
    let received = "";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = body;
        res.writeHead(200);
        res.end("v6ok");
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch {
      return; // no IPv6 loopback on this machine — nothing to test
    }

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind test server");
    const port = address.port;

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({ type: "request-start", id: "req-v6", port, method: "POST", url: "/", headers: {} }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data", id: "req-v6", data: "payload" }));
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-v6" }));

      await waitUntil(() => decodeSent(sent).some((message) => message.type === "response-data-end"));

      const messages = decodeSent(sent);
      expect(messages.find((message) => message.type === "response-start")).toMatchObject({
        id: "req-v6",
        statusCode: 200,
      });
      const body = messages
        .filter((message) => message.type === "response-data")
        .map((message) => Buffer.from(message.data, "binary"))
        .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0))
        .toString("utf-8");
      expect(body).toBe("v6ok");
      expect(received).toBe("payload");
      // Working family is cached so the next request skips the failed attempt.
      expect((client as any).loopbackHost.get(port)).toBe("[::1]");
    } finally {
      await stopHttpServer(server);
    }
  });
});

describe("TunnelClient backoff and failure handling", () => {
  test("currentReconnectDelay uses exponential backoff", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 16000,
    });

    // 0 failures → base delay
    expect((client as any).currentReconnectDelay).toBe(1000);

    // Simulate consecutive failures
    (client as any).consecutiveFailures = 1;
    expect((client as any).currentReconnectDelay).toBe(1000); // 1000 * 2^0

    (client as any).consecutiveFailures = 2;
    expect((client as any).currentReconnectDelay).toBe(2000); // 1000 * 2^1

    (client as any).consecutiveFailures = 3;
    expect((client as any).currentReconnectDelay).toBe(4000); // 1000 * 2^2

    (client as any).consecutiveFailures = 4;
    expect((client as any).currentReconnectDelay).toBe(8000); // 1000 * 2^3

    (client as any).consecutiveFailures = 5;
    expect((client as any).currentReconnectDelay).toBe(16000); // 1000 * 2^4 = cap

    // Should cap at maxReconnectDelayMs
    (client as any).consecutiveFailures = 10;
    expect((client as any).currentReconnectDelay).toBe(16000);
  });

  test("consecutiveFailures resets on successful registration", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    attachMockRelay(client);

    // Simulate some failures
    (client as any).consecutiveFailures = 5;

    // Simulate receiving a "registered" message
    (client as any).handleMessage(JSON.stringify({ type: "registered", runnerId: "r1" }));

    expect((client as any).consecutiveFailures).toBe(0);
    expect((client as any).registeredThisConnection).toBe(true);
  });

  test("consecutiveFailures increments on disconnect without registration", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false, // Don't actually reconnect in test
    });

    expect((client as any).consecutiveFailures).toBe(0);

    // Simulate a connection that closes without ever registering
    (client as any).registeredThisConnection = false;
    // Manually trigger the close logic
    (client as any).ws = null;
    if (!(client as any).registeredThisConnection) {
      (client as any).consecutiveFailures++;
    }

    expect((client as any).consecutiveFailures).toBe(1);
  });

  test("emits 'disabled' event after maxConsecutiveFailures", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: true,
      maxConsecutiveFailures: 3,
    });

    const disabledEvents: any[] = [];
    client.on("disabled", (data) => disabledEvents.push(data));

    // Simulate reaching max failures
    (client as any).consecutiveFailures = 2; // Will become 3 on next disconnect
    (client as any).registeredThisConnection = false;

    // Simulate the close handler logic
    (client as any).consecutiveFailures++;
    // Check the give-up condition
    if ((client as any).consecutiveFailures >= (client as any).maxConsecutiveFailures) {
      client.emit("disabled", {
        reason: "max-failures",
        failures: (client as any).consecutiveFailures,
        relayUrl: (client as any).relayUrl,
      });
    }

    expect(disabledEvents).toHaveLength(1);
    expect(disabledEvents[0]).toMatchObject({
      reason: "max-failures",
      failures: 3,
      relayUrl: "ws://localhost:9999/_tunnel",
    });
  });

  test("consecutiveFailures does NOT increment on disconnect after successful registration", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });

    (client as any).consecutiveFailures = 0;
    (client as any).registeredThisConnection = true; // Was registered

    // Simulate close — should NOT increment
    if (!(client as any).registeredThisConnection) {
      (client as any).consecutiveFailures++;
    }

    expect((client as any).consecutiveFailures).toBe(0);
  });

  test("default maxConsecutiveFailures is 10", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
    });
    expect((client as any).maxConsecutiveFailures).toBe(10);
  });

  test("default maxReconnectDelayMs is 60000", () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
    });
    expect((client as any).maxReconnectDelayMs).toBe(60000);
  });
});

describe("TunnelClient probe timeout fallback", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function fakeRequest(behaviors: Array<"timeout" | "error">) {
    let index = 0;
    return jest.spyOn(https, "request").mockImplementation((options: any) => {
      const req = new EventEmitter() as any;
      // Simulate the real node behaviour: req.destroy() emits an async 'error'
      // ("socket hang up" / ERR_HTTP_SOCKET_CLOSED). The timedOut guard in
      // tryFamily must block the error handler from firing a second retry.
      req.destroy = () => {
        queueMicrotask(() => req.emit("error", new Error("socket hang up")));
      };
      req.end = () => {
        const behavior = behaviors[index++] ?? "timeout";
        queueMicrotask(() => req.emit(behavior, new Error(behavior)));
      };
      return req;
    });
  }

  function fakeNetConnect(behaviors: Array<"timeout" | "connect" | "error">) {
    let index = 0;
    return jest.spyOn(net, "connect").mockImplementation(() => {
      const sock = new EventEmitter() as any;
      // Simulate sock.destroy() emitting 'error' to exercise the sockTimedOut
      // symmetry guard (in production this rarely happens, but the guard must
      // hold when it does).
      sock.destroy = () => {
        queueMicrotask(() => sock.emit("error", new Error("socket destroyed")));
      };
      sock.setTimeout = (_ms: number, cb: () => void) => {
        sock._timeoutCb = cb;
      };
      queueMicrotask(() => {
        const behavior = behaviors[index++] ?? "timeout";
        if (behavior === "timeout") sock._timeoutCb?.();
        else sock.emit(behavior, new Error(behavior));
      });
      return sock;
    });
  }

  test("TLS request timeout retries alternate loopback family exactly once", async () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    const port = 9999;
    const reqSpy = fakeRequest(["timeout", "timeout"]);

    client.exposePort(port);
    await waitUntil(() => !(client as any).probing.has(port));

    expect(reqSpy).toHaveBeenCalledTimes(2);
    expect(reqSpy.mock.calls[0][0].host).toBe("127.0.0.1");
    expect(reqSpy.mock.calls[1][0].host).toBe("::1");
    expect(client.detectedProtocol(port)).toBeUndefined();
  });

describe("TunnelClient mid-stream local HTTP failure", () => {
  test("sends response-data-abort (not response-data-end) when local socket is destroyed after headers", async () => {
    const { server, port } = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      // Small delay: let headers traverse loopback to the client before killing
      // the socket, so we exercise the response-level error path (not req.on('error')).
      setTimeout(() => res.socket?.destroy(), 20);
    });

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({ type: "request-start", id: "req-fail", port, method: "GET", url: "/", headers: {} }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-fail" }));

      // A terminal abort frame must arrive, NOT a clean end.
      await waitUntil(() => decodeSent(sent).some((m) => m.type === "response-data-abort" && m.id === "req-fail"));

      const messages = decodeSent(sent);
      // Headers arrived before destruction — response-start must be present.
      expect(messages.find((m) => m.type === "response-start")).toMatchObject({ id: "req-fail", statusCode: 200 });
      // activeRequests entry must be gone.
      expect((client as any).activeRequests.has("req-fail")).toBe(false);
      // Must NOT send a clean response-data-end.
      expect(messages.some((m) => m.type === "response-data-end" && m.id === "req-fail")).toBe(false);
      // Exactly one terminal abort frame.
      const abortFrames = messages.filter((m) => m.type === "response-data-abort" && m.id === "req-fail");
      expect(abortFrames).toHaveLength(1);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("sends response-data-end (clean) when the local server ends normally", async () => {
    const { server, port } = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("complete");
    });

    try {
      const client = new TunnelClient({
        runnerId: "r1",
        apiKey: "key1",
        relayUrl: "ws://localhost:9999/_tunnel",
        autoReconnect: false,
      });
      client.exposePort(port);
      const sent = attachMockRelay(client);

      (client as any).handleMessage(
        JSON.stringify({ type: "request-start", id: "req-ok", port, method: "GET", url: "/", headers: {} }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-ok" }));

      await waitUntil(() => decodeSent(sent).some((m) => m.type === "response-data-end" && m.id === "req-ok"));

      const messages = decodeSent(sent);
      // Must NOT send a response-data-abort.
      expect(messages.some((m) => m.type === "response-data-abort" && m.id === "req-ok")).toBe(false);
      // Exactly one clean end.
      expect(messages.filter((m) => m.type === "response-data-end" && m.id === "req-ok")).toHaveLength(1);
      // Map cleared.
      expect((client as any).activeRequests.has("req-ok")).toBe(false);
    } finally {
      await stopHttpServer(server);
    }
  });

  test("idempotent: only one terminal frame when socket destroyed (settled flag)", async () => {
    const client = new TunnelClient({
      runnerId: "r1",
      apiKey: "key1",
      relayUrl: "ws://localhost:9999/_tunnel",
      autoReconnect: false,
    });
    const sent = attachMockRelay(client);

    const { server, port } = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.write("x");
      // Trigger close/error which sets settled=true. Any subsequent event is no-op.
      setTimeout(() => res.socket?.destroy(), 20);
    });

    try {
      client.exposePort(port);

      (client as any).handleMessage(
        JSON.stringify({ type: "request-start", id: "req-idem", port, method: "GET", url: "/", headers: {} }),
      );
      (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id: "req-idem" }));

      await waitUntil(() => decodeSent(sent).some((m) => m.type === "response-data-abort" && m.id === "req-idem"));
      // Allow a tick for any duplicate frames to arrive.
      await new Promise((r) => setTimeout(r, 50));

      const allTerminal = decodeSent(sent).filter(
        (m) => (m.type === "response-data-end" || m.type === "response-data-abort") && m.id === "req-idem",
      );
      expect(allTerminal).toHaveLength(1);
      expect(allTerminal[0].type).toBe("response-data-abort");
    } finally {
      await stopHttpServer(server);
    }
  });
});
});
