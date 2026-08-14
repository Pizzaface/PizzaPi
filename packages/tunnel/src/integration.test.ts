import { afterEach, describe, expect, test } from "bun:test";
import http, { type Server as HttpServer } from "node:http";
import https from "node:https";
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
    preserveAuth?: boolean;
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
        preserveAuth: options.preserveAuth,
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

afterEach(async () => {
  client?.removeAllListeners();
  await client?.dispose();
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

/** TEST-ONLY self-signed key/cert for the local HTTPS target (CN=127.0.0.1, throwaway). */
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDbuPAsFhV7ArRF
q/Opp3kcLSMsGBbIeeaH/RkxfhcpwsfqUGZjD8RsNlFVWp7K3Ym3r4i29P+OdZF9
5NfHOlVF/Ob3JgH4IXklwOESjt2lXdJb84YnWGvAG0lNvpZvKNKJh/AUDWpNib7Z
pByZgnhVyKeE8dXgKZB4cYhr8838gov+T1hJmqhShMO2p8SfD9Ww5GBcUwJmhfMn
AjUjxj5LWQ4I4cULMNwCysb5VekSs/ptdb3zZaYWiTPU8/C28zpOTaLCsbrLoj05
KulXWa+zXO64g/5s3pW/iIgQQfzwC68vOC2SuOrFVFiSXaxeQ1e7fK5+Kbp+DL8j
T93Hfca3AgMBAAECggEAE15FBY3YzOQbIf0bWHwjx+EOtadV8swUDy63Vs6Hmi3K
U5RMwjS0mtla6Aw57SYEKsX1ZjNIh7VDYvaWMsConafCcEzQZaAFvtc2v90KGraf
gW2BCNzZerCtEIZZWmkdzfPGrO3VzgnzYdn+j2WZ1+39HlH3CXCAhK11Wha+tKBf
gRMIQwFwqMr4ktQ1vKDGm1mH6dusGZ01GETx539zY3YIqjrZc/Az9xeH9qu1Yl+M
UVd45F8mN/W7ZfEpREqeVzSJCgNERL8/zu2WYz5yqihmKGhQO6jWec4pU9vTGmQa
YhPVHIjoEvhwFDPANZzdNpq+LXdZnRynfiousaVRMQKBgQD2SPqVhzqkmSSTBNFI
+fdQ5BMyRSiT2HxxG+htOkyacDqwr81cLcVJzylJ1YmlJ6FhYezdhSbUk0vRj1Kh
TUqP/q8EogXJ0bFTTnjVIIfyy19/lfVUlAwDvbx4QkWbr3zwv/E3vghwHyLTq/ar
IL3rM3mZRZA4B3BfGiXpXsXPaQKBgQDkY7nTSV4fuFQe47NF2vVeG9J/buF+UVut
q9MXyjfiNYtIMtvKc/gMt0PDUt+gwHIm2oh3rhl66z8B8tPRirjPzuTYEMs2272S
69SKfqi1H93eake7tOGK2BHZkFa8tL0meaMUesaylBc9LBIrlotH86bgNnL/XPD8
x/4t2OBBHwKBgQCbdnu/Uaph5k2hBER7tVY5WI8Jh4BSuy/qUjyIXmmmfzt89qxC
CJ5ltgARHFsTxo1nJGJZfsiBHS2Z7ceyDFEJzjF6UjAnMlemB33cwvkt+NSie+1t
4zomTmme2+6GlOLgMbk5f5ph9DWOuhkt8rAPvOGAL9oWlBOJ5L6TroBdKQKBgQDJ
2FkionTNE9tEcXi/BARWZ8BhX11qhfzAQFsPa2h4Q1oVNN2Kz3Mpyc3ZkiSRrYM1
U23IV9WtDLtivXj2d+NdxTv6uNzgXtPsRQBSZh4z9TXgm41KF1I9ozgjT61YmWOR
3W6Dav6wVLE1Hv3wB9yQeoXBIl3/0eQpg5bgbgvDgQKBgQDSITQTGwRU4J5ZugYH
BYcFDIXelfmZKDSP9RvKQ6UrfQ6TM1c2YPFF9A1CTd3YR49LV048Dw93KevI4l7Y
pgm/W6QdCuTr8+UIhnqiraQLnj97Tazl8/tUxU/Xfpx4A8OIbCxt/aiFSWNKmkZv
0yFIfoGqmschletmGuLWNLjb7Q==
-----END PRIVATE KEY-----
`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUGrqepgvJDGf9ey1vD8z+qHH84OIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDgxNDE1NTMwOVoYDzIxMjYw
NzIxMTU1MzA5WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDbuPAsFhV7ArRFq/Opp3kcLSMsGBbIeeaH/Rkxfhcp
wsfqUGZjD8RsNlFVWp7K3Ym3r4i29P+OdZF95NfHOlVF/Ob3JgH4IXklwOESjt2l
XdJb84YnWGvAG0lNvpZvKNKJh/AUDWpNib7ZpByZgnhVyKeE8dXgKZB4cYhr8838
gov+T1hJmqhShMO2p8SfD9Ww5GBcUwJmhfMnAjUjxj5LWQ4I4cULMNwCysb5VekS
s/ptdb3zZaYWiTPU8/C28zpOTaLCsbrLoj05KulXWa+zXO64g/5s3pW/iIgQQfzw
C68vOC2SuOrFVFiSXaxeQ1e7fK5+Kbp+DL8jT93Hfca3AgMBAAGjUzBRMB0GA1Ud
DgQWBBRKQhEuEyMIWrbqFQy91P7vkWteHTAfBgNVHSMEGDAWgBRKQhEuEyMIWrbq
FQy91P7vkWteHTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBi
sqpVdF8stf/34LXIsCuN97LCxk/xmGyI+GmDNnJNIYhMl1jHQuKcj1uCvwX0YkyJ
/8l1wWCg9hXDRIxEri82JJT/mPUEp3HL8/FJSsS1sGtkqagAWvk517XWqJFNVfYy
GF/9v6EEn1YGy9AqUCQhPQefUwKopPfkoV7HNt3BRz4s/310CU/GWI2xeLUF9CB7
aUC/dN6t+M/BRoZdmDYTuCuTeMAiubcXfhxzgbFZyIg2WRJGtCr7sVuEziz5glxJ
dNHBvEns4bIRcEPL85e+YSoft/9yf+yP63vPqhzMKqJMAhONF9oFKzy0tQA5uhGp
mXM3Nz6SR/nKB433Db85
-----END CERTIFICATE-----
`;

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
  test("cookie/authorization stripped by default, forwarded with preserveAuth", async () => {
    const seen: Array<{ cookie?: string; auth?: string }> = [];
    localHttpServer = http.createServer((req, res) => {
      seen.push({ cookie: req.headers.cookie, auth: req.headers.authorization });
      res.writeHead(200);
      res.end("ok");
    });
    const localPort = await listen(localHttpServer);
    await startRelayAndClient([localPort]);

    const credHeaders = { cookie: "app=1", authorization: "Bearer tok" };
    await proxyHttpRequestThroughTunnel(localPort, { id: "req-strip", headers: credHeaders });
    await proxyHttpRequestThroughTunnel(localPort, { id: "req-keep", headers: credHeaders, preserveAuth: true });

    expect(seen[0]).toEqual({ cookie: undefined, auth: undefined });
    expect(seen[1]).toEqual({ cookie: "app=1", auth: "Bearer tok" });
  });

  test("HTTPS local target is auto-detected and proxied (self-signed)", async () => {
    let seenMethod = "";
    const localHttpsServer = https.createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      (req, res) => {
        seenMethod = req.method ?? "";
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("secure-ok");
      },
    );
    localHttpServer = localHttpsServer as unknown as HttpServer;
    const localPort = await listen(localHttpServer);

    await startRelayAndClient([localPort]);
    // exposePort kicks the protocol probe; wait for it to settle on https.
    await waitUntil(() => client!.detectedProtocol(localPort) === "https");

    const response = await proxyHttpRequestThroughTunnel(localPort, {
      id: "req-https-1",
      method: "GET",
      url: "/secure",
    });

    expect(seenMethod).toBe("GET");
    expect(response.statusCode).toBe(200);
    expect(response.body.toString("utf-8")).toBe("secure-ok");
  });
});
