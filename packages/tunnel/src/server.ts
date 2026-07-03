import { Buffer } from "node:buffer";
import type {
  TunnelClientMessage,
  TunnelRequestEndMessage,
  TunnelResponseDataEndMessage,
  TunnelResponseDataMessage,
  TunnelResponseStartMessage,
  TunnelServerMessage,
  TunnelWsCloseMessage,
  TunnelWsDataMessage,
  TunnelWsErrorMessage,
  TunnelWsOpenedMessage,
  TunnelRegisterMessage,
} from "./types.js";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;

export interface TunnelRelayOptions {
  /** Static API key list, or an async authorize function (returns owning userId, or null to reject). */
  apiKeys: string[] | ((apiKey: string, runnerId: string) => Promise<string | null | boolean>);
  /** Optional logger (defaults to no-op). */
  log?: TunnelLogger;
}

export interface TunnelLogger {
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const noopLog: TunnelLogger = {
  info() {},
  debug() {},
  error() {},
  warn() {},
};

interface RegisteredRunner {
  runnerId: string;
  userId: string;
  ws: WebSocket;
  lastPongAt: number;
}

export interface PendingProxyRequest {
  id: string;
  runnerId: string;
  port: number;
  onResponseStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void;
  onResponseData: (data: Buffer) => void;
  onResponseEnd: () => void;
  onError: (error: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingWsProxy {
  id: string;
  runnerId: string;
  onOpened: (protocol?: string) => void;
  onData: (data: string, binary?: boolean) => void;
  onClose: (code?: number, reason?: string) => void;
  onError: (message: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseMessageText(raw: string | Buffer | ArrayBuffer | ArrayBufferView): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf-8");
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf-8");
  }
  return Buffer.from(raw).toString("utf-8");
}

export class TunnelRelay {
  private authorizeApiKey: (apiKey: string, runnerId: string) => Promise<string | null | boolean>;
  private log: TunnelLogger;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private runners = new Map<string, RegisteredRunner>();
  private pendingRequests = new Map<string, PendingProxyRequest>();
  private pendingWs = new Map<string, PendingWsProxy>();
  private wsToRunner = new Map<WebSocket, string>();

  constructor(options: TunnelRelayOptions) {
    if (Array.isArray(options.apiKeys)) {
      const keys = options.apiKeys.filter((key) => key !== "");
      if (keys.length === 0) {
        throw new Error("TunnelRelay: at least one non-empty API key is required");
      }
      const keySet = new Set(keys);
      this.authorizeApiKey = async (key: string) => (keySet.has(key) ? "default" : null);
    } else {
      this.authorizeApiKey = options.apiKeys;
    }

    this.log = options.log ?? noopLog;

    this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), PING_INTERVAL_MS);
    this.heartbeatInterval.unref();
  }

  getRunner(runnerId: string): WebSocket | undefined {
    return this.runners.get(runnerId)?.ws;
  }

  hasRunner(runnerId: string): boolean {
    return this.runners.has(runnerId);
  }

  handleConnection(ws: WebSocket): void {
    ws.addEventListener("message", (event: MessageEvent) => {
      void this.handleMessage(ws, event.data as string | Buffer | ArrayBuffer | ArrayBufferView);
    });
    ws.addEventListener("close", () => {
      this.handleDisconnect(ws);
    });
    ws.addEventListener("error", () => {
      this.handleDisconnect(ws);
    });
  }

  proxyHttpRequest(
    runnerId: string,
    request: {
      id: string;
      port: number;
      method: string;
      url: string;
      headers: Record<string, string>;
    },
    callbacks: {
      onResponseStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void;
      onResponseData: (data: Buffer) => void;
      onResponseEnd: () => void;
      onError: (error: string) => void;
    },
    timeoutMs = 30_000,
  ): { cancel: () => void } {
    const runner = this.runners.get(runnerId);
    if (!runner) {
      callbacks.onError(`Runner ${runnerId} not connected`);
      return { cancel() {} };
    }

    const timer = setTimeout(() => {
      this.send(runner.ws, { type: "request-end", id: request.id });
      this.pendingRequests.delete(request.id);
      callbacks.onError("Tunnel request timed out");
    }, timeoutMs);

    this.pendingRequests.set(request.id, {
      id: request.id,
      runnerId,
      port: request.port,
      onResponseStart: callbacks.onResponseStart,
      onResponseData: callbacks.onResponseData,
      onResponseEnd: callbacks.onResponseEnd,
      onError: callbacks.onError,
      timer,
    });

    this.send(runner.ws, {
      type: "request-start",
      id: request.id,
      port: request.port,
      method: request.method,
      url: request.url,
      headers: request.headers,
    });

    return {
      cancel: () => {
        const pending = this.pendingRequests.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(request.id);
        this.send(runner.ws, { type: "request-end", id: request.id });
      },
    };
  }

  sendRequestData(runnerId: string, requestId: string, data: Buffer): void {
    const runner = this.runners.get(runnerId);
    if (!runner) return;
    this.send(runner.ws, {
      type: "request-data",
      id: requestId,
      data: data.toString("binary"),
    });
  }

  sendRequestDataEnd(runnerId: string, requestId: string): void {
    const runner = this.runners.get(runnerId);
    if (!runner) return;
    this.send(runner.ws, { type: "request-data-end", id: requestId });
  }

  proxyWsOpen(
    runnerId: string,
    request: {
      id: string;
      port: number;
      path: string;
      protocols?: string[];
      headers: Record<string, string>;
    },
    callbacks: {
      onOpened: (protocol?: string) => void;
      onData: (data: string, binary?: boolean) => void;
      onClose: (code?: number, reason?: string) => void;
      onError: (message: string) => void;
    },
    timeoutMs = 10_000,
  ): { cancel: () => void } {
    const runner = this.runners.get(runnerId);
    if (!runner) {
      callbacks.onError(`Runner ${runnerId} not connected`);
      return { cancel() {} };
    }

    const timer = setTimeout(() => {
      this.send(runner.ws, { type: "ws-close", id: request.id, code: 1001, reason: "open timeout" });
      this.pendingWs.delete(request.id);
      callbacks.onError("WebSocket open timed out");
    }, timeoutMs);

    this.pendingWs.set(request.id, {
      id: request.id,
      runnerId,
      onOpened: callbacks.onOpened,
      onData: callbacks.onData,
      onClose: callbacks.onClose,
      onError: callbacks.onError,
      timer,
    });

    this.send(runner.ws, {
      type: "ws-open",
      id: request.id,
      port: request.port,
      path: request.path,
      protocols: request.protocols,
      headers: request.headers,
    });

    return {
      cancel: () => {
        const pending = this.pendingWs.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingWs.delete(request.id);
        this.send(runner.ws, { type: "ws-close", id: request.id, code: 1001, reason: "cancelled" });
      },
    };
  }

  sendWsData(runnerId: string, wsId: string, data: string, binary?: boolean): void {
    const runner = this.runners.get(runnerId);
    if (!runner) return;
    this.send(runner.ws, { type: "ws-data", id: wsId, data, binary });
  }

  sendWsClose(runnerId: string, wsId: string, code?: number, reason?: string): void {
    const runner = this.runners.get(runnerId);
    if (!runner) return;
    this.send(runner.ws, { type: "ws-close", id: wsId, code, reason });
  }

  dispose(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.onError("Relay shutting down");
    }
    this.pendingRequests.clear();

    for (const pending of this.pendingWs.values()) {
      clearTimeout(pending.timer);
      pending.onError("Relay shutting down");
    }
    this.pendingWs.clear();

    this.runners.clear();
    this.wsToRunner.clear();
  }

  private send(ws: WebSocket, msg: TunnelServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(ws: WebSocket, raw: string | Buffer | ArrayBuffer | ArrayBufferView): Promise<void> {
    let msg: TunnelClientMessage;
    try {
      msg = JSON.parse(parseMessageText(raw)) as TunnelClientMessage;
    } catch {
      this.log.error("[tunnel-relay] Invalid JSON from client");
      return;
    }

    switch (msg.type) {
      case "register":
        await this.handleRegister(ws, msg);
        break;
      case "response-start":
        this.handleResponseStart(msg);
        break;
      case "response-data":
        this.handleResponseData(msg);
        break;
      case "response-data-end":
        this.handleResponseDataEnd(msg);
        break;
      case "request-end":
        this.handleRequestEnd(msg);
        break;
      case "ws-opened":
        this.handleWsOpened(msg);
        break;
      case "ws-data":
        this.handleWsData(msg);
        break;
      case "ws-close":
        this.handleWsClose(msg);
        break;
      case "ws-error":
        this.handleWsError(msg);
        break;
      case "pong": {
        const runnerId = this.wsToRunner.get(ws);
        if (runnerId) {
          const runner = this.runners.get(runnerId);
          if (runner) runner.lastPongAt = Date.now();
        }
        break;
      }
      default:
        this.log.warn("[tunnel-relay] Unknown message type:", (msg as { type: string }).type);
    }
  }

  private async handleRegister(ws: WebSocket, msg: TunnelRegisterMessage): Promise<void> {
    const authResult = await this.authorizeApiKey(msg.apiKey, msg.runnerId);
    if (!authResult) {
      this.log.error("[tunnel-relay] Invalid API key from runner", msg.runnerId);
      this.send(ws, { type: "error", message: "Invalid API key" });
      ws.close();
      return;
    }

    const userId = typeof authResult === "string" ? authResult : "default";

    const existing = this.runners.get(msg.runnerId);
    if (existing && existing.userId !== userId) {
      this.log.error("[tunnel-relay] Runner ownership mismatch, rejecting:", msg.runnerId);
      this.send(ws, { type: "error", message: "Runner already registered by another user" });
      ws.close();
      return;
    }

    if (existing) {
      this.log.warn("[tunnel-relay] Runner re-registering, closing old connection:", msg.runnerId);
      this.wsToRunner.delete(existing.ws);
      try {
        existing.ws.close();
      } catch {
        // ignore close errors
      }
    }

    const now = Date.now();
    this.runners.set(msg.runnerId, { runnerId: msg.runnerId, userId, ws, lastPongAt: now });
    this.wsToRunner.set(ws, msg.runnerId);
    this.log.info("[tunnel-relay] Runner registered:", msg.runnerId);
    this.send(ws, { type: "registered", runnerId: msg.runnerId });
  }

  private handleResponseStart(msg: TunnelResponseStartMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;
    // The timeout only protects the initial response handshake. Once headers
    // have arrived, the response may legitimately be long-lived (SSE, logs,
    // streaming dev servers), so do not abort it solely because it stays open.
    clearTimeout(pending.timer);
    pending.onResponseStart(msg.statusCode, msg.statusMessage, msg.headers);
  }

  private handleResponseData(msg: TunnelResponseDataMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;
    pending.onResponseData(Buffer.from(msg.data, "binary"));
  }

  private handleResponseDataEnd(msg: TunnelResponseDataEndMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.onResponseEnd();
  }

  private handleRequestEnd(msg: TunnelRequestEndMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.onError("Runner aborted request");
  }

  private handleWsOpened(msg: TunnelWsOpenedMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.onOpened(msg.protocol);
  }

  private handleWsData(msg: TunnelWsDataMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!pending) return;
    pending.onData(msg.data, msg.binary);
  }

  private handleWsClose(msg: TunnelWsCloseMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingWs.delete(msg.id);
    pending.onClose(msg.code, msg.reason);
  }

  private handleWsError(msg: TunnelWsErrorMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingWs.delete(msg.id);
    pending.onError(msg.message);
  }

  private sendHeartbeats(): void {
    const now = Date.now();
    for (const [runnerId, runner] of this.runners) {
      if (now - runner.lastPongAt > PONG_TIMEOUT_MS) {
        this.log.warn("[tunnel-relay] Runner missed heartbeats, removing:", runnerId);
        this.removeRunner(runnerId, "Runner missed heartbeats");
        continue;
      }
      this.send(runner.ws, { type: "ping" });
    }
  }

  private removeRunner(runnerId: string, reason: string): void {
    const runner = this.runners.get(runnerId);
    if (!runner) return;

    this.log.info("[tunnel-relay] Runner removed:", runnerId, reason);
    this.runners.delete(runnerId);
    this.wsToRunner.delete(runner.ws);

    try {
      runner.ws.close();
    } catch {
      // ignore close errors
    }

    for (const [id, pending] of this.pendingRequests) {
      if (!this.isRequestForRunner(id, runnerId)) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.onError(reason);
    }

    for (const [id, pending] of this.pendingWs) {
      if (pending.runnerId !== runnerId) continue;
      clearTimeout(pending.timer);
      this.pendingWs.delete(id);
      pending.onError(reason);
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    const runnerId = this.wsToRunner.get(ws);
    if (!runnerId) return;
    this.removeRunner(runnerId, "Runner disconnected");
  }

  private isRequestForRunner(requestId: string, runnerId: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    return pending?.runnerId === runnerId;
  }
}
