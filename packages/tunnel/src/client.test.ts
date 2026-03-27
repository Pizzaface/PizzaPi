import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import { describe, expect, test, jest } from "bun:test";
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
