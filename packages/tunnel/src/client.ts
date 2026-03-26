import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import http from "node:http";
import type {
  TunnelClientMessage,
  TunnelRequestDataEndMessage,
  TunnelRequestDataMessage,
  TunnelRequestEndMessage,
  TunnelRequestStartMessage,
  TunnelServerMessage,
  TunnelWsCloseMessage,
  TunnelWsDataMessage,
  TunnelWsOpenMessage,
} from "./types.js";

export interface TunnelClientOptions {
  runnerId: string;
  apiKey: string;
  /** WebSocket URL of the relay (for example: ws://localhost:3000/_tunnel). */
  relayUrl: string;
  /** Optional logger. */
  log?: TunnelClientLogger;
  /** Auto-reconnect on disconnect. Default true. */
  autoReconnect?: boolean;
  /** Reconnect delay in ms. Default 3000. */
  reconnectDelayMs?: number;
}

export interface TunnelClientLogger {
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const noopLog: TunnelClientLogger = {
  info() {},
  debug() {},
  error() {},
  warn() {},
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "host",
  // Strip accept-encoding so the local service returns uncompressed responses.
  // The tunnel serialises body chunks as JSON strings (Latin-1 "binary" encoding),
  // so upstream compression saves nothing.  More critically, the server-side
  // HTML/JS/CSS rewriting path needs plaintext — if the local service returns
  // gzip/br, the rewriter interprets compressed bytes as UTF-8 → garbled output.
  "accept-encoding",
]);

const STRIP_AUTH = new Set(["cookie", "authorization", "x-api-key"]);

function parseMessageText(raw: string | Buffer | ArrayBuffer | ArrayBufferView): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf-8");
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf-8");
  }
  return Buffer.from(raw).toString("utf-8");
}

export class TunnelClient extends EventEmitter {
  private runnerId: string;
  private apiKey: string;
  private relayUrl: string;
  private log: TunnelClientLogger;
  private autoReconnect: boolean;
  private reconnectDelayMs: number;

  private ws: WebSocket | null = null;
  private exposedPorts = new Set<number>();
  private disposed = false;

  /** Active HTTP requests: requestId → { controller, req } */
  private activeRequests = new Map<string, { controller: AbortController; req: http.ClientRequest }>();
  /** Active local WebSocket connections: wsId → WebSocket */
  private activeWs = new Map<string, WebSocket>();

  constructor(options: TunnelClientOptions) {
    super();
    this.runnerId = options.runnerId;
    this.apiKey = options.apiKey;
    this.relayUrl = options.relayUrl;
    this.log = options.log ?? noopLog;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.log.info("[tunnel-client] Connecting to", this.relayUrl);
    this.ws = new WebSocket(this.relayUrl);

    this.ws.addEventListener("open", () => {
      this.log.info("[tunnel-client] Connected, registering as", this.runnerId);
      this.send({ type: "register", runnerId: this.runnerId, apiKey: this.apiKey });
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data as string | Buffer | ArrayBuffer | ArrayBufferView);
    });

    this.ws.addEventListener("close", () => {
      this.log.info("[tunnel-client] Disconnected");
      this.cleanup();
      this.ws = null;
      this.emit("disconnect");
      if (this.autoReconnect && !this.disposed) {
        setTimeout(() => this.connect(), this.reconnectDelayMs);
      }
    });

    this.ws.addEventListener("error", (error) => {
      this.log.error("[tunnel-client] WebSocket error:", error);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cleanup();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  exposePort(port: number): void {
    this.exposedPorts.add(port);
  }

  unexposePort(port: number): void {
    this.exposedPorts.delete(port);
  }

  isPortExposed(port: number): boolean {
    return this.exposedPorts.has(port);
  }

  private send(msg: TunnelClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(raw: string | Buffer | ArrayBuffer | ArrayBufferView): void {
    let msg: TunnelServerMessage;
    try {
      msg = JSON.parse(parseMessageText(raw)) as TunnelServerMessage;
    } catch {
      this.log.error("[tunnel-client] Invalid JSON from relay");
      return;
    }

    switch (msg.type) {
      case "registered":
        this.log.info("[tunnel-client] Registered as", msg.runnerId);
        this.emit("registered", msg.runnerId);
        break;
      case "error": {
        const error = new Error(msg.message);
        this.log.error("[tunnel-client] Relay error:", msg.message);
        if (this.listenerCount("error") > 0) {
          this.emit("error", error);
        }
        break;
      }
      case "request-start":
        this.handleRequestStart(msg);
        break;
      case "request-data":
        this.handleRequestData(msg);
        break;
      case "request-data-end":
        this.handleRequestDataEnd(msg);
        break;
      case "request-end":
        this.handleRequestEnd(msg);
        break;
      case "ws-open":
        this.handleWsOpen(msg);
        break;
      case "ws-data":
        this.handleWsData(msg);
        break;
      case "ws-close":
        this.handleWsClose(msg);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
    }
  }

  private handleRequestStart(msg: TunnelRequestStartMessage): void {
    const { id, port, method, url: requestUrl, headers } = msg;

    if (!this.exposedPorts.has(port)) {
      this.log.warn("[tunnel-client] Request for unexposed port", port);
      this.send({ type: "response-start", id, statusCode: 404, statusMessage: "Not Found", headers: {} });
      this.send({ type: "response-data", id, data: `Port ${port} is not exposed` });
      this.send({ type: "response-data-end", id });
      return;
    }

    const targetUrl = `http://127.0.0.1:${port}${requestUrl}`;
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      this.send({ type: "response-start", id, statusCode: 400, statusMessage: "Bad Request", headers: {} });
      this.send({ type: "response-data-end", id });
      return;
    }

    if (parsed.hostname !== "127.0.0.1") {
      this.send({ type: "response-start", id, statusCode: 400, statusMessage: "SSRF blocked", headers: {} });
      this.send({ type: "response-data-end", id });
      return;
    }

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (!HOP_BY_HOP.has(lowerKey) && !STRIP_AUTH.has(lowerKey)) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders.host = `127.0.0.1:${port}`;

    const controller = new AbortController();
    const req = http.request(
      parsed,
      {
        method,
        headers: forwardHeaders,
        signal: controller.signal,
      },
      (response) => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          const lowerKey = key.toLowerCase();
          if (HOP_BY_HOP.has(lowerKey)) continue;
          responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
        }

        this.send({
          type: "response-start",
          id,
          statusCode: response.statusCode ?? 502,
          statusMessage: response.statusMessage ?? "",
          headers: responseHeaders,
        });

        response.on("data", (chunk: Buffer) => {
          this.send({ type: "response-data", id, data: chunk.toString("binary") });
        });

        response.on("end", () => {
          this.activeRequests.delete(id);
          this.send({ type: "response-data-end", id });
        });

        controller.signal.addEventListener(
          "abort",
          () => {
            response.destroy();
          },
          { once: true },
        );
      },
    );

    this.activeRequests.set(id, { controller, req });

    req.on("error", (error) => {
      this.activeRequests.delete(id);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ABORT_ERR" || controller.signal.aborted) {
        return;
      }
      this.send({
        type: "response-start",
        id,
        statusCode: 502,
        statusMessage: "Bad Gateway",
        headers: {},
      });
      this.send({
        type: "response-data",
        id,
        data:
          code === "ECONNREFUSED"
            ? `Local service not available on port ${port}`
            : `${error.message} (${code ?? "UNKNOWN"})`,
      });
      this.send({ type: "response-data-end", id });
    });
  }

  private handleRequestData(msg: TunnelRequestDataMessage): void {
    const active = this.activeRequests.get(msg.id);
    if (!active) return;
    active.req.write(Buffer.from(msg.data, "binary"));
  }

  private handleRequestDataEnd(msg: TunnelRequestDataEndMessage): void {
    const active = this.activeRequests.get(msg.id);
    if (!active) return;
    active.req.end();
  }

  private handleRequestEnd(msg: TunnelRequestEndMessage): void {
    const active = this.activeRequests.get(msg.id);
    if (!active) return;
    active.controller.abort();
    active.req.destroy();
    this.activeRequests.delete(msg.id);
  }

  private handleWsOpen(msg: TunnelWsOpenMessage): void {
    const { id, port, path, protocols, headers } = msg;

    if (!this.exposedPorts.has(port)) {
      this.send({ type: "ws-error", id, message: `Port ${port} is not exposed` });
      return;
    }

    const targetUrl = `ws://127.0.0.1:${port}${path}`;
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      this.send({ type: "ws-error", id, message: "Invalid WebSocket URL" });
      return;
    }

    if (parsed.hostname !== "127.0.0.1") {
      this.send({ type: "ws-error", id, message: "SSRF blocked" });
      return;
    }

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (!HOP_BY_HOP.has(lowerKey) && !STRIP_AUTH.has(lowerKey)) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders.host = `127.0.0.1:${port}`;

    try {
      const WebSocketCtor = WebSocket as unknown as {
        new (
          url: string,
          options?: {
            headers?: Record<string, string>;
            protocols?: string[];
          },
        ): WebSocket;
      };

      const ws = new WebSocketCtor(parsed.toString(), {
        headers: forwardHeaders,
        protocols,
      });

      this.activeWs.set(id, ws);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        this.send({ type: "ws-opened", id, protocol: ws.protocol || undefined });
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
        this.send({
          type: "ws-data",
          id,
          data: isBinary
            ? Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data instanceof ArrayBuffer ? undefined : data.byteOffset, data instanceof ArrayBuffer ? undefined : data.byteLength).toString("base64")
            : String(data),
          binary: isBinary || undefined,
        });
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        this.activeWs.delete(id);
        this.send({ type: "ws-close", id, code: event.code, reason: event.reason });
      });

      ws.addEventListener("error", () => {
        this.activeWs.delete(id);
        this.send({ type: "ws-error", id, message: "WebSocket connection error" });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "ws-error", id, message });
    }
  }

  private handleWsData(msg: TunnelWsDataMessage): void {
    const ws = this.activeWs.get(msg.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (msg.binary) {
        ws.send(Buffer.from(msg.data, "base64"));
      } else {
        ws.send(msg.data);
      }
    } catch {
      // ignore send errors
    }
  }

  private handleWsClose(msg: TunnelWsCloseMessage): void {
    const ws = this.activeWs.get(msg.id);
    if (!ws) return;
    this.activeWs.delete(msg.id);
    try {
      ws.close(msg.code ?? 1000, msg.reason ?? "");
    } catch {
      // ignore close errors
    }
  }

  private cleanup(): void {
    for (const { controller, req } of this.activeRequests.values()) {
      controller.abort();
      req.destroy();
    }
    this.activeRequests.clear();

    for (const ws of this.activeWs.values()) {
      try {
        ws.close(1001, "tunnel client disconnected");
      } catch {
        // ignore close errors
      }
    }
    this.activeWs.clear();
  }
}
