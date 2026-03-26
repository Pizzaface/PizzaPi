import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import { describe, expect, test } from "bun:test";
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
