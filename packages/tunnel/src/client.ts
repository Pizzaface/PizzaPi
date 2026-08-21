import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
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
  /** Initial reconnect delay in ms. Default 3000. */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (exponential backoff cap). Default 60000. */
  maxReconnectDelayMs?: number;
  /** Stop reconnecting after this many consecutive failures. Default 10. */
  maxConsecutiveFailures?: number;
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

type LoopbackHost = "127.0.0.1" | "[::1]";

function otherLoopback(host: LoopbackHost): LoopbackHost {
  return host === "127.0.0.1" ? "[::1]" : "127.0.0.1";
}

/** Max request-body bytes buffered to allow a loopback-family retry replay. */
const RETRY_BODY_BUFFER_LIMIT = 4 * 1024 * 1024;

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
  private maxReconnectDelayMs: number;
  private maxConsecutiveFailures: number;

  private ws: WebSocket | null = null;
  private exposedPorts = new Set<number>();
  private disposed = false;
  /** Prevents stale close handlers from interfering after dispose/reconnect. */
  private connectionGeneration = 0;

  /** Tracks consecutive connection failures (never received "registered"). */
  private consecutiveFailures = 0;
  /** Whether a "registered" message was received for the current connection. */
  private registeredThisConnection = false;
  /** Wall-clock time when the current WebSocket attempt was created. */
  private connectionStartedAt = 0;

  /** Active HTTP requests: requestId → { controller, req } */
  private activeRequests = new Map<
    string,
    {
      controller: AbortController;
      req: http.ClientRequest;
      /** Body chunks buffered for loopback retry replay; null once connected or over limit. */
      bodyChunks: Buffer[] | null;
      bodyBytes: number;
      bodyEnded: boolean;
    }
  >();
  /**
   * ponytail: on Windows `localhost` often resolves to ::1 first, so local dev
   * servers can be IPv6-only and 127.0.0.1 gets ECONNREFUSED. We retry the
   * other loopback family once and cache the working family per port.
   */
  private loopbackHost = new Map<number, LoopbackHost>();
  /** Active local WebSocket connections: wsId → WebSocket */
  private activeWs = new Map<string, WebSocket>();
  /** Detected protocol per exposed port (TLS probe result). */
  private portProtocol = new Map<number, "http" | "https">();
  /** Ports with a TLS probe currently in flight. */
  private probing = new Set<number>();

  constructor(options: TunnelClientOptions) {
    super();
    this.runnerId = options.runnerId;
    this.apiKey = options.apiKey;
    this.relayUrl = options.relayUrl;
    this.log = options.log ?? noopLog;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;
  }

  /** Current reconnect delay (increases with consecutive failures). */
  private get currentReconnectDelay(): number {
    if (this.consecutiveFailures === 0) return this.reconnectDelayMs;
    const delay = this.reconnectDelayMs * Math.pow(2, this.consecutiveFailures - 1);
    return Math.min(delay, this.maxReconnectDelayMs);
  }

  connect(): void {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.connectionGeneration++;
    this.registeredThisConnection = false;
    this.connectionStartedAt = Date.now();
    this.log.info("[tunnel-client] Connecting to", this.relayUrl);
    this.ws = new WebSocket(this.relayUrl);

    this.ws.addEventListener("open", () => {
      this.log.info("[tunnel-client] Connected, registering as", this.runnerId);
      this.send({ type: "register", runnerId: this.runnerId, apiKey: this.apiKey });
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data as string | Buffer | ArrayBuffer | ArrayBufferView);
    });

    const generation = this.connectionGeneration;
    this.ws.addEventListener("close", (event: CloseEvent) => {
      if (generation !== this.connectionGeneration) return;
      const uptimeMs = this.connectionStartedAt > 0 ? Date.now() - this.connectionStartedAt : undefined;
      this.log.info(
        "[tunnel-client] Disconnected",
        JSON.stringify({
          code: event.code,
          reason: event.reason || undefined,
          wasClean: event.wasClean,
          registered: this.registeredThisConnection,
          consecutiveFailures: this.consecutiveFailures,
          uptimeMs,
          activeRequests: this.activeRequests.size,
          activeWs: this.activeWs.size,
        }),
      );
      this.cleanup();
      this.ws = null;

      if (!this.registeredThisConnection) {
        this.consecutiveFailures++;
      }

      this.emit("disconnect");

      if (this.autoReconnect && !this.disposed) {
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          this.log.warn(
            `[tunnel-client] Giving up after ${this.consecutiveFailures} consecutive failed connections.`,
            "The relay server may not support the /_tunnel endpoint — upgrade the server or run 'pizza web'.",
          );
          this.emit("disabled", {
            reason: "max-failures",
            failures: this.consecutiveFailures,
            relayUrl: this.relayUrl,
          });
          return;
        }
        const delay = this.currentReconnectDelay;
        if (this.consecutiveFailures > 0) {
          this.log.info(`[tunnel-client] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.consecutiveFailures + 1}/${this.maxConsecutiveFailures})`);
        }
        setTimeout(() => this.connect(), delay);
      }
    });

    this.ws.addEventListener("error", (event) => {
      // ErrorEvent.toString() produces "[object ErrorEvent]" which is useless.
      // Extract the actual error message if available.
      const msg = (event as any)?.message
        ?? (event as any)?.error?.message
        ?? (event as any)?.error
        ?? (event as any)?.type
        ?? "unknown error";
      this.log.error(
        "[tunnel-client] WebSocket error:",
        msg,
        JSON.stringify({
          relayUrl: this.relayUrl,
          readyState: this.ws?.readyState,
          registered: this.registeredThisConnection,
          consecutiveFailures: this.consecutiveFailures,
        }),
      );
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.connectionGeneration++;
    this.cleanup();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          const onClose = () => resolve();
          ws.addEventListener("close", onClose, { once: true });
          setTimeout(onClose, 2_000); // ponytail: safety net for stuck close
          try { ws.close(); } catch { /* ignore */ }
        });
      }
    }
  }

  exposePort(port: number): void {
    this.exposedPorts.add(port);
    this.probeProtocol(port);
  }

  unexposePort(port: number): void {
    this.exposedPorts.delete(port);
    this.portProtocol.delete(port);
  }

  /**
   * One-shot protocol probe: HEAD / over TLS. Success → https. On failure, a
   * plain TCP connect disambiguates: connectable → the service speaks plain
   * http (cache it); not connectable → try the other loopback family, then
   * cache nothing so the next request re-probes.
   *
   * NOTE: raw tls.connect is NOT usable here — under Bun it fires secureConnect
   * (with authorized=true!) against plain-HTTP servers. A real https request is
   * the only handshake signal that behaves on both runtimes.
   */
  private probeProtocol(port: number): void {
    if (this.portProtocol.has(port) || this.probing.has(port)) return;
    this.probing.add(port);
    let settled = false;
    const done = (proto: "http" | "https" | null, family?: LoopbackHost): void => {
      if (settled) return;
      settled = true;
      this.probing.delete(port);
      if (proto) {
        this.portProtocol.set(port, proto);
        if (family) this.loopbackHost.set(port, family);
      }
    };

    const tryFamily = (bracketHost: LoopbackHost, canRetry: boolean): void => {
      if (settled) return;
      const host = bracketHost.replace(/^\[|\]$/g, "");
      const req = https.request(
        { host, port, path: "/", method: "HEAD", rejectUnauthorized: false, timeout: 1500 },
        (res) => {
          res.resume();
          done("https", bracketHost);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done(null);
      });
      req.on("error", () => {
        // TLS failed — is anything listening at all? (Bun reports bogus
        // ECONNREFUSED for TLS-to-plain-HTTP, so error codes can't be trusted.)
        const sock = net.connect({ host, port });
        sock.setTimeout(1500, () => {
          sock.destroy();
          done(null);
        });
        sock.once("connect", () => {
          sock.destroy();
          done("http", bracketHost);
        });
        sock.once("error", () => {
          // Nothing on this family — an IPv6-only HTTPS service would
          // otherwise never be detected (the http path's family retry only
          // converges for plaintext services).
          if (canRetry) tryFamily(otherLoopback(bracketHost), false);
          else done(null);
        });
      });
      req.end();
    };

    tryFamily(this.loopbackHost.get(port) ?? "127.0.0.1", true);
  }

  isPortExposed(port: number): boolean {
    return this.exposedPorts.has(port);
  }

  /** Probe result for an exposed port (undefined while undetected). */
  detectedProtocol(port: number): "http" | "https" | undefined {
    return this.portProtocol.get(port);
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
        this.registeredThisConnection = true;
        this.consecutiveFailures = 0;
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
    const { id, port, method, url: requestUrl, headers, preserveAuth } = msg;

    if (!this.exposedPorts.has(port)) {
      this.log.warn("[tunnel-client] Request for unexposed port", port);
      this.send({ type: "response-start", id, statusCode: 404, statusMessage: "Not Found", headers: {} });
      this.send({ type: "response-data", id, data: `Port ${port} is not exposed` });
      this.send({ type: "response-data-end", id });
      return;
    }

    // ponytail: requests never await the probe — an undetected port defaults to
    // plain http, so the first request(s) to a late-started HTTPS service 502
    // once, the error clears/refills the cache, and the next request works.
    // Upgrade path if that ever matters: make the probe a per-port promise and
    // buffer request-data messages until it settles.
    const useTls = this.portProtocol.get(port) === "https";
    if (!this.portProtocol.has(port)) this.probeProtocol(port);

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
      if (HOP_BY_HOP.has(lowerKey)) continue;
      // Host-based tunnels forward the app's own credentials (preserveAuth);
      // path-based tunnels strip them — they may be relay credentials.
      if (!preserveAuth && STRIP_AUTH.has(lowerKey)) continue;
      forwardHeaders[key] = value;
    }
    forwardHeaders.host = `127.0.0.1:${port}`;

    const controller = new AbortController();
    const attempt = (hostname: LoopbackHost, canRetry: boolean): http.ClientRequest => {
    const target = new URL(parsed.toString());
    target.hostname = hostname;
    if (useTls) target.protocol = "https:";
    const req = (useTls ? https : http).request(
      target,
      {
        method,
        headers: forwardHeaders,
        signal: controller.signal,
        // Local dev HTTPS is almost always self-signed — this stays loopback-only.
        ...(useTls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        this.loopbackHost.set(port, hostname);
        const active = this.activeRequests.get(id);
        if (active) active.bodyChunks = null; // connected — replay buffer no longer needed
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          const lowerKey = key.toLowerCase();
          if (HOP_BY_HOP.has(lowerKey)) continue;
          // Preserve arrays — joining multi-value headers with ", " breaks
          // Set-Cookie (cookie values legally contain commas in Expires).
          responseHeaders[key] = value;
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

        // Idempotent terminal: delete from map + send end frame exactly once.
        let settled = false;
        const terminate = () => {
          if (settled) return;
          settled = true;
          this.activeRequests.delete(id);
          this.send({ type: "response-data-end", id });
        };

        response.on("end", terminate);

        // Mid-stream failures (socket reset / service crash after headers sent).
        // Each fires terminate() which is a no-op after the first call.
        response.on("error", terminate);
        // "aborted" is a legacy Node.js event still fired by some runtimes.
        response.on("aborted", terminate);
        // "close" fires on premature socket teardown AND after a clean end —
        // the settled guard makes it a no-op in the happy path.
        response.on("close", terminate);

        controller.signal.addEventListener(
          "abort",
          () => {
            response.destroy();
          },
          { once: true },
        );
      },
    );

    req.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ABORT_ERR" || controller.signal.aborted) {
        this.activeRequests.delete(id);
        return;
      }
      const active = this.activeRequests.get(id);
      if (code === "ECONNREFUSED" && canRetry && active?.bodyChunks) {
        // Local service may be listening on the other loopback family
        // (IPv6-only binds are common on Windows). Retry once, replaying
        // any buffered request body.
        this.loopbackHost.delete(port);
        const retryReq = attempt(otherLoopback(hostname), false);
        active.req = retryReq;
        for (const chunk of active.bodyChunks) retryReq.write(chunk);
        if (active.bodyEnded) retryReq.end();
        return;
      }
      this.activeRequests.delete(id);
      // The cached protocol may be stale (service restarted as HTTP↔HTTPS) —
      // clear it so the next request re-probes.
      this.portProtocol.delete(port);
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
    return req;
    };

    const req = attempt(this.loopbackHost.get(port) ?? "127.0.0.1", true);
    this.activeRequests.set(id, { controller, req, bodyChunks: [], bodyBytes: 0, bodyEnded: false });
  }

  private handleRequestData(msg: TunnelRequestDataMessage): void {
    const active = this.activeRequests.get(msg.id);
    if (!active) return;
    const chunk = Buffer.from(msg.data, "binary");
    if (active.bodyChunks) {
      active.bodyBytes += chunk.length;
      if (active.bodyBytes > RETRY_BODY_BUFFER_LIMIT) {
        active.bodyChunks = null; // too big to replay — give up on retry, stop buffering
      } else {
        active.bodyChunks.push(chunk);
      }
    }
    active.req.write(chunk);
  }

  private handleRequestDataEnd(msg: TunnelRequestDataEndMessage): void {
    const active = this.activeRequests.get(msg.id);
    if (!active) return;
    active.bodyEnded = true;
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
    const { id, port, path, protocols, headers, preserveAuth } = msg;

    if (!this.exposedPorts.has(port)) {
      this.send({ type: "ws-error", id, message: `Port ${port} is not exposed` });
      return;
    }

    const wsUseTls = this.portProtocol.get(port) === "https";
    if (!this.portProtocol.has(port)) this.probeProtocol(port); // late-started service — fill cache for next attempt
    const targetUrl = `${wsUseTls ? "wss" : "ws"}://127.0.0.1:${port}${path}`;
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
      if (HOP_BY_HOP.has(lowerKey)) continue;
      if (!preserveAuth && STRIP_AUTH.has(lowerKey)) continue;
      forwardHeaders[key] = value;
    }
    forwardHeaders.host = `127.0.0.1:${port}`;

    const connect = (hostname: LoopbackHost, canRetry: boolean): void => {
    try {
      const WebSocketCtor = WebSocket as unknown as {
        new (
          url: string,
          options?: {
            headers?: Record<string, string>;
            protocols?: string[];
            tls?: { rejectUnauthorized?: boolean };
          },
        ): WebSocket;
      };

      const target = new URL(parsed.toString());
      target.hostname = hostname;
      let opened = false;
      const ws = new WebSocketCtor(target.toString(), {
        headers: forwardHeaders,
        protocols,
        // ponytail: Bun-specific option; if the runtime ignores it, wss to a
        // self-signed local cert fails — no worse than the pre-TLS behavior.
        ...(wsUseTls ? { tls: { rejectUnauthorized: false } } : {}),
      });

      this.activeWs.set(id, ws);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        opened = true;
        this.loopbackHost.set(port, hostname);
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
        if (this.activeWs.get(id) !== ws) return; // superseded by loopback retry
        this.activeWs.delete(id);
        if (!opened && canRetry) {
          this.loopbackHost.delete(port);
          connect(otherLoopback(hostname), false);
          return;
        }
        this.send({ type: "ws-close", id, code: event.code, reason: event.reason });
      });

      ws.addEventListener("error", () => {
        if (this.activeWs.get(id) !== ws) return; // superseded by loopback retry
        this.activeWs.delete(id);
        if (!opened && canRetry) {
          this.loopbackHost.delete(port);
          connect(otherLoopback(hostname), false);
          return;
        }
        if (!opened) this.portProtocol.delete(port); // stale protocol cache — re-probe next time
        this.send({ type: "ws-error", id, message: "WebSocket connection error" });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "ws-error", id, message });
    }
    };

    connect(this.loopbackHost.get(port) ?? "127.0.0.1", true);
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
