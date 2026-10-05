/**
 * Runner-side tunnel resource bounds: local responses honour relay pause /
 * relay-socket congestion (real backpressure on the local producer), slow
 * local request-body consumers push back on the relay and are terminated at
 * the hard buffer limit, and WebSockets that outrun their consumer close.
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { describe, expect, test } from "bun:test";
import { TunnelClient } from "./client.js";

function attachMockRelay(client: TunnelClient) {
  const sent: string[] = [];
  const relay = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  };
  (client as any).ws = relay;
  return { sent, relay };
}

function decode(sent: string[]): Array<Record<string, any>> {
  return sent.map((value) => JSON.parse(value));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A local service that streams `chunks` × 1 KiB, one every 5 ms. */
async function startStreamingServer(chunks: number): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let sentChunks = 0;
    const timer = setInterval(() => {
      if (sentChunks >= chunks) {
        clearInterval(timer);
        res.end();
        return;
      }
      sentChunks++;
      res.write(Buffer.alloc(1024, 0x61));
    }, 5);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { server, port: address.port };
}

function newClient(maxBufferedBytes?: number): TunnelClient {
  return new TunnelClient({
    runnerId: "r1",
    apiKey: "k",
    relayUrl: "ws://localhost:9999/_tunnel",
    autoReconnect: false,
    maxBufferedBytes,
  });
}

function startGet(client: TunnelClient, id: string, port: number): void {
  (client as any).handleMessage(JSON.stringify({ type: "request-start", id, port, method: "GET", url: "/", headers: {} }));
  (client as any).handleMessage(JSON.stringify({ type: "request-data-end", id }));
}

const dataBytes = (sent: string[], id: string) =>
  decode(sent)
    .filter((m) => m.type === "response-data" && m.id === id)
    .reduce((n, m) => n + Buffer.from(m.data, "binary").length, 0);

describe("TunnelClient response backpressure", () => {
  test("response-pause stops reading the local response until response-resume", async () => {
    const { server, port } = await startStreamingServer(40);
    try {
      const client = newClient();
      client.exposePort(port);
      const { sent } = attachMockRelay(client);
      startGet(client, "r-pause", port);
      await waitUntil(() => dataBytes(sent, "r-pause") > 0);

      (client as any).handleMessage(JSON.stringify({ type: "response-pause", id: "r-pause" }));
      await sleep(30); // let any already-emitted chunk land
      const paused = dataBytes(sent, "r-pause");
      await sleep(150);
      expect(dataBytes(sent, "r-pause")).toBe(paused);
      expect(paused).toBeLessThan(40 * 1024);

      (client as any).handleMessage(JSON.stringify({ type: "response-resume", id: "r-pause" }));
      await waitUntil(() => decode(sent).some((m) => m.type === "response-data-end" && m.id === "r-pause"));
      expect(dataBytes(sent, "r-pause")).toBe(40 * 1024);
    } finally {
      server.close();
    }
  });

  test("pauses the local response while the relay socket is congested", async () => {
    const { server, port } = await startStreamingServer(40);
    try {
      const client = newClient();
      client.exposePort(port);
      const { sent, relay } = attachMockRelay(client);
      relay.bufferedAmount = 8 * 1024 * 1024; // relay link far behind
      startGet(client, "r-cong", port);
      await waitUntil(() => dataBytes(sent, "r-cong") > 0);
      await sleep(30);
      const paused = dataBytes(sent, "r-cong");
      await sleep(150);
      expect(dataBytes(sent, "r-cong")).toBe(paused);

      relay.bufferedAmount = 0; // drained
      await waitUntil(() => decode(sent).some((m) => m.type === "response-data-end" && m.id === "r-cong"));
      expect(dataBytes(sent, "r-cong")).toBe(40 * 1024);
    } finally {
      server.close();
    }
  });
});

describe("TunnelClient request-body backpressure and limits", () => {
  function fakeRequest() {
    const req = new EventEmitter() as EventEmitter & {
      writableLength: number;
      accept: boolean;
      write(chunk: Buffer): boolean;
      end(): void;
      destroy(): void;
      destroyed: boolean;
    };
    req.writableLength = 0;
    req.accept = true;
    req.destroyed = false;
    req.write = (chunk: Buffer) => {
      req.writableLength += chunk.length;
      return req.accept;
    };
    req.end = () => {};
    req.destroy = () => {
      req.destroyed = true;
    };
    return req;
  }

  function seed(client: TunnelClient, id: string, req: ReturnType<typeof fakeRequest>) {
    (client as any).activeRequests.set(id, {
      controller: new AbortController(),
      req,
      bodyChunks: null,
      bodyBytes: 0,
      bodyEnded: false,
      responseStarted: false,
      response: null,
      relayPaused: false,
      socketPaused: false,
      requestPaused: false,
    });
  }

  test("asks the relay to pause when the local service stops draining, and resumes on drain", () => {
    const client = newClient(1024 * 1024);
    const { sent } = attachMockRelay(client);
    const req = fakeRequest();
    seed(client, "b1", req);

    req.accept = false;
    (client as any).handleRequestData({ type: "request-data", id: "b1", data: "x".repeat(100) });
    (client as any).handleRequestData({ type: "request-data", id: "b1", data: "x".repeat(100) });
    expect(decode(sent).filter((m) => m.type === "request-pause")).toEqual([{ type: "request-pause", id: "b1" }]);

    req.accept = true;
    req.writableLength = 0;
    req.emit("drain");
    expect(decode(sent).at(-1)).toEqual({ type: "request-resume", id: "b1" });
  });

  test("terminates a request whose unread body exceeds maxBufferedBytes", () => {
    const client = newClient(1000);
    const { sent } = attachMockRelay(client);
    const req = fakeRequest();
    seed(client, "b2", req);
    req.accept = false;

    (client as any).handleRequestData({ type: "request-data", id: "b2", data: "x".repeat(600) });
    expect((client as any).activeRequests.has("b2")).toBe(true);
    (client as any).handleRequestData({ type: "request-data", id: "b2", data: "x".repeat(600) });

    expect((client as any).activeRequests.has("b2")).toBe(false);
    expect(req.destroyed).toBe(true);
    const msgs = decode(sent).filter((m) => m.id === "b2" && m.type.startsWith("response-"));
    expect(msgs[0]).toMatchObject({ type: "response-start", statusCode: 502 });
    expect(msgs.at(-1)).toEqual({ type: "response-data-end", id: "b2" });
  });

  test("rejects an invalid maxBufferedBytes", () => {
    expect(() => newClient(-1)).toThrow();
  });
});

describe("TunnelClient WebSocket buffer limits", () => {
  test("closes a local WebSocket that is not draining relay frames", () => {
    const client = newClient(1000);
    const { sent } = attachMockRelay(client);
    let closedWith: number | undefined;
    const frames: unknown[] = [];
    (client as any).activeWs.set("w1", {
      readyState: WebSocket.OPEN,
      bufferedAmount: 5000,
      send(data: unknown) {
        frames.push(data);
      },
      close(code: number) {
        closedWith = code;
      },
    });

    (client as any).handleWsData({ type: "ws-data", id: "w1", data: "hello" });

    expect(frames).toEqual([]);
    expect(closedWith).toBe(1013);
    expect((client as any).activeWs.has("w1")).toBe(false);
    expect(decode(sent)).toEqual([{ type: "ws-close", id: "w1", code: 1013, reason: "local WebSocket buffer limit exceeded" }]);
  });
});
