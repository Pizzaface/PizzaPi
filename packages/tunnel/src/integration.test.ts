import { afterEach, describe, expect, test } from "bun:test";
import http, { type Server as HttpServer } from "node:http";
import { once } from "node:events";
import { TunnelClient } from "./client.js";
import { TunnelRelay } from "./server.js";
import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";

let relay: TunnelRelay | undefined;
let client: TunnelClient | undefined;
let relayServer: HttpServer | undefined;
let relayWss: WebSocketServer | undefined;
let localHttpServer: HttpServer | undefined;
let localWsHttpServer: HttpServer | undefined;
let localWss: WebSocketServer | undefined;
async function listen(server: HttpServer): Promise<number> {
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

  return address.port;
}

function closeServer(server: HttpServer | undefined): void {
  if (!server) return;

  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (server.listening) {
    server.close();
  }
  server.unref();
}

function closeWebSocketServer(wss: WebSocketServer | undefined): void {
  if (!wss) return;

  for (const socket of wss.clients) {
    try {
      socket.terminate();
    } catch {
      // ignore cleanup termination errors
    }
  }

  wss.close();
}

async function reserveUnusedPort(): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });

  const port = await listen(server);
  closeServer(server);
  await waitUntil(() => !server.listening);
  return port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startRelayAndClient(exposedPorts: number[] = []): Promise<void> {
  relay = new TunnelRelay({ apiKeys: ["test-key"] });
  relayWss = new WebSocketServer({ noServer: true });
  relayWss.on("connection", (ws) => {
    relay!.handleConnection(ws as unknown as WebSocket);
  });

  relayServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  relayServer.on("upgrade", (req, socket, head) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== "/_tunnel") {
      socket.destroy();
      return;
    }

    relayWss!.handleUpgrade(req, socket, head, (ws) => {
      relayWss!.emit("connection", ws, req);
    });
  });

  const relayPort = await listen(relayServer);
  client = new TunnelClient({
    runnerId: "test-runner",
    apiKey: "test-key",
    relayUrl: `ws://127.0.0.1:${relayPort}/_tunnel`,
    autoReconnect: false,
  });
  client.on("error", () => {
    // prevent EventEmitter 'error' from failing cleanup paths in tests that
    // intentionally exercise failures
  });

  for (const port of exposedPorts) {
    client.exposePort(port);
  }

  const registered = once(client, "registered");
  client.connect();
  await registered;
  await waitUntil(() => relay?.hasRunner("test-runner") === true);
}

async function proxyHttpRequestThroughTunnel(
  port: number,
  options: {
    id: string;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    requestBody?: Buffer;
  },
): Promise<{
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Buffer;
  chunks: Buffer[];
}> {
  if (!relay) {
    throw new Error("Relay not initialized");
  }

  const chunks: Buffer[] = [];
  let statusCode = 0;
  let statusMessage = "";
  let headers: Record<string, string> = {};

  await new Promise<void>((resolve, reject) => {
    relay!.proxyHttpRequest(
      "test-runner",
      {
        id: options.id,
        port,
        method: options.method ?? "GET",
        url: options.url ?? "/",
        headers: options.headers ?? {},
      },
      {
        onResponseStart(code, message, responseHeaders) {
          statusCode = code;
          statusMessage = message;
          headers = responseHeaders;
        },
        onResponseData(chunk) {
          chunks.push(chunk);
        },
        onResponseEnd() {
          resolve();
        },
        onError(error) {
          reject(new Error(error));
        },
      },
    );

    if (options.requestBody) {
      relay!.sendRequestData("test-runner", options.id, options.requestBody);
    }
    relay!.sendRequestDataEnd("test-runner", options.id);
  });

  return {
    statusCode,
    statusMessage,
    headers,
    body: Buffer.concat(chunks),
    chunks,
  };
}

afterEach(() => {
  client?.removeAllListeners();
  client?.dispose();
  client = undefined;

  closeWebSocketServer(localWss);
  localWss = undefined;
  closeServer(localWsHttpServer);
  localWsHttpServer = undefined;

  closeWebSocketServer(relayWss);
  relayWss = undefined;
  relay?.dispose();
  relay = undefined;
  closeServer(relayServer);
  relayServer = undefined;

  closeServer(localHttpServer);
  localHttpServer = undefined;
});

describe("Streaming tunnel integration", () => {
  test("HTTP request streams through tunnel with status, headers, and all chunks", async () => {
    let seenMethod = "";
    let seenUrl = "";
    let seenHeader = "";

    localHttpServer = http.createServer((req, res) => {
      seenMethod = req.method ?? "";
      seenUrl = req.url ?? "";
      seenHeader = req.headers["x-test-header"] as string;

      res.writeHead(201, "Created", {
        "content-type": "text/plain; charset=utf-8",
        "x-stream-mode": "chunked",
      });
      res.write("chunk-1|");
      setTimeout(() => {
        res.write("chunk-2|");
        setTimeout(() => {
          res.end("chunk-3");
        }, 25);
      }, 25);
    });
    const localPort = await listen(localHttpServer);

    await startRelayAndClient([localPort]);

    const response = await proxyHttpRequestThroughTunnel(localPort, {
      id: "req-http-1",
      method: "GET",
      url: "/stream?x=1",
      headers: { "x-test-header": "viewer" },
    });

    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("/stream?x=1");
    expect(seenHeader).toBe("viewer");
    expect(response.statusCode).toBe(201);
    expect(response.statusMessage).toBe("Created");
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["x-stream-mode"]).toBe("chunked");
    expect(response.body.toString("utf-8")).toBe("chunk-1|chunk-2|chunk-3");
    expect(response.chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("WebSocket traffic tunnels relay → client → local WS server → back", async () => {
    const messagesFromRelay: string[] = [];
    let receivedByLocalServer = "";
    let openedProtocol: string | undefined;
    let closeInfo: { code?: number; reason?: string } | undefined;

    localWsHttpServer = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    localWss = new WebSocketServer({
      server: localWsHttpServer,
      handleProtocols(protocols) {
        return protocols.has("chat") ? "chat" : false;
      },
    });

    localWss.on("connection", (ws: NodeWebSocket) => {
      ws.send("hello-from-local");
      ws.on("message", (data, isBinary) => {
        receivedByLocalServer = isBinary ? Buffer.from(data).toString("utf-8") : data.toString();
        ws.send(`echo:${receivedByLocalServer}`);
        setTimeout(() => {
          ws.close(1000, "done");
        }, 10);
      });
    });

    const localWsPort = await listen(localWsHttpServer);
    await startRelayAndClient([localWsPort]);

    await new Promise<void>((resolve, reject) => {
      relay!.proxyWsOpen(
        "test-runner",
        {
          id: "ws-1",
          port: localWsPort,
          path: "/socket?room=demo",
          protocols: ["chat"],
          headers: { "x-test-header": "viewer" },
        },
        {
          onOpened(protocol) {
            openedProtocol = protocol;
            relay!.sendWsData("test-runner", "ws-1", "viewer->local");
          },
          onData(data) {
            messagesFromRelay.push(data);
          },
          onClose(code, reason) {
            closeInfo = { code, reason };
            resolve();
          },
          onError(message) {
            reject(new Error(message));
          },
        },
      );
    });

    expect(openedProtocol).toBe("chat");
    expect(receivedByLocalServer).toBe("viewer->local");
    expect(messagesFromRelay).toContain("hello-from-local");
    expect(messagesFromRelay).toContain("echo:viewer->local");
    expect(closeInfo).toEqual({ code: 1000, reason: "done" });
  });

  test("request to an unexposed port returns 404", async () => {
    await startRelayAndClient();

    const response = await proxyHttpRequestThroughTunnel(43123, {
      id: "req-unexposed",
      method: "GET",
      url: "/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.statusMessage).toBe("Not Found");
    expect(response.headers).toEqual({});
    expect(response.body.toString("utf-8")).toBe("Port 43123 is not exposed");
  });

  test("connection refused from an exposed but unavailable local service returns 502", async () => {
    const unusedPort = await reserveUnusedPort();
    await startRelayAndClient([unusedPort]);

    const response = await proxyHttpRequestThroughTunnel(unusedPort, {
      id: "req-conn-refused",
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toBe(502);
    expect(response.statusMessage).toBe("Bad Gateway");
    expect(response.body.toString("utf-8")).toBe(`Local service not available on port ${unusedPort}`);
  });
});
