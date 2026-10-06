import { Buffer } from "node:buffer";
import type {
  TunnelClientMessage,
  TunnelRequestEndMessage,
  TunnelResponseDataAbortMessage,
  TunnelResponseDataEndMessage,
  TunnelResponseDataMessage,
  TunnelResponseStartMessage,
  TunnelServerMessage,
  TunnelWsCloseMessage,
  TunnelWsDataMessage,
  TunnelWsErrorMessage,
  TunnelWsOpenedMessage,
  TunnelRegisterMessage,
  TunnelRequestPauseMessage,
  TunnelRequestResumeMessage,
} from "./types.js";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;

/**
 * Resource bounds for tunnelled traffic. `0` disables a limit. Every limit is
 * enforced per request / WebSocket (except `maxInFlightPerRunner`).
 */
export interface TunnelRelayLimits {
  /** Max total request-body bytes forwarded to the runner per HTTP request. */
  maxRequestBodyBytes: number;
  /** Max total response-body bytes accepted from the runner per HTTP request. */
  maxResponseBodyBytes: number;
  /** Max concurrent HTTP requests + WebSockets proxied to a single runner. */
  maxInFlightPerRunner: number;
  /**
   * Hard ceiling on bytes queued for any single slow consumer (runner socket
   * send buffer, viewer response stream, viewer WebSocket). Producers are
   * paused well before this; exceeding it terminates the stream.
   */
  maxBufferedBytes: number;
}

export const DEFAULT_TUNNEL_RELAY_LIMITS: Readonly<TunnelRelayLimits> = Object.freeze({
  maxRequestBodyBytes: 100 * 1024 * 1024,
  maxResponseBodyBytes: 0,
  maxInFlightPerRunner: 256,
  maxBufferedBytes: 64 * 1024 * 1024,
});

/**
 * Soft high-water mark: senders wait (backpressure) while the runner socket
 * has more than this many bytes queued.
 */
export const TUNNEL_SEND_HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 10;

export interface TunnelRelayOptions {
  /** Static API key list, or an async authorize function (returns owning userId, or null to reject). */
  apiKeys: string[] | ((apiKey: string, runnerId: string) => Promise<string | null | boolean>);
  /** Optional logger (defaults to no-op). */
  log?: TunnelLogger;
  /** Resource limits; unspecified fields use {@link DEFAULT_TUNNEL_RELAY_LIMITS}. */
  limits?: Partial<TunnelRelayLimits>;
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
  onResponseStart: (statusCode: number, statusMessage: string, headers: Record<string, string | string[]>) => void;
  onResponseData: (data: Buffer) => void;
  onResponseEnd: () => void;
  onError: (error: string) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Request-body bytes forwarded so far. */
  requestBytes: number;
  /** Response-body bytes received so far. */
  responseBytes: number;
  /** Runner asked us to stop sending request-data (local service is slow). */
  requestPaused: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponseHeaders(value: unknown): value is Record<string, string | string[]> {
  return isRecord(value) && Object.values(value).every(
    (entry) => typeof entry === "string" || (Array.isArray(entry) && entry.every((item) => typeof item === "string")),
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isHttpStatus(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 599;
}

function isOptionalCloseCode(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && ((value >= 1000 && value <= 1015) || (value >= 3000 && value <= 4999)));
}

function browserCloseCode(code: number | undefined): number {
  return code === 1000 || (code !== undefined && code >= 3000) ? code : 1000;
}

function isOptionalCloseReason(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 123);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isTunnelClientMessage(value: unknown): value is TunnelClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "register": return typeof value.runnerId === "string" && typeof value.apiKey === "string";
    case "response-start": return typeof value.id === "string" && isHttpStatus(value.statusCode)
      && typeof value.statusMessage === "string" && isResponseHeaders(value.headers);
    case "response-data": return typeof value.id === "string" && typeof value.data === "string";
    case "response-data-end": return typeof value.id === "string";
    case "response-data-abort": return typeof value.id === "string" && isOptionalString(value.reason);
    case "request-end":
    case "request-pause":
    case "request-resume": return typeof value.id === "string";
    case "ws-opened": return typeof value.id === "string" && isOptionalString(value.protocol);
    case "ws-data": return typeof value.id === "string" && typeof value.data === "string" && isOptionalBoolean(value.binary);
    case "ws-close": return typeof value.id === "string" && isOptionalCloseCode(value.code) && isOptionalCloseReason(value.reason);
    case "ws-error": return typeof value.id === "string" && typeof value.message === "string";
    case "pong": return true;
    default: return false;
  }
}

function resolveLimits(overrides: Partial<TunnelRelayLimits> | undefined): TunnelRelayLimits {
  const limits: TunnelRelayLimits = { ...DEFAULT_TUNNEL_RELAY_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof TunnelRelayLimits>) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`TunnelRelay: limits.${key} must be a non-negative finite number`);
    }
    limits[key] = Math.floor(value);
  }
  return limits;
}

/** bufferedAmount of a socket, tolerating adapters/mocks that do not expose it. */
function socketBufferedAmount(ws: WebSocket): number {
  const amount = (ws as { bufferedAmount?: unknown }).bufferedAmount;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
}

export class TunnelRelay {
  private authorizeApiKey: (apiKey: string, runnerId: string) => Promise<string | null | boolean>;
  private log: TunnelLogger;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private runners = new Map<string, RegisteredRunner>();
  private pendingRequests = new Map<string, PendingProxyRequest>();
  private pendingWs = new Map<string, PendingWsProxy>();
  private wsToRunner = new Map<WebSocket, string>();
  readonly limits: Readonly<TunnelRelayLimits>;

  constructor(options: TunnelRelayOptions) {
    this.limits = Object.freeze(resolveLimits(options.limits));
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
      void this.handleMessage(ws, event.data as string | Buffer | ArrayBuffer | ArrayBufferView).catch((error: unknown) => {
        this.log.error("[tunnel-relay] Failed to handle client message:", error);
      });
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
      preserveAuth?: boolean;
      host?: string;
      capabilityAgeMs?: number;
    },
    callbacks: {
      onResponseStart: (statusCode: number, statusMessage: string, headers: Record<string, string | string[]>) => void;
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
    if (this.atInFlightLimit(runnerId, request.id)) {
      callbacks.onError("Too many concurrent tunnel requests for this runner");
      return { cancel() {} };
    }

    let pending!: PendingProxyRequest;
    const timer = setTimeout(() => {
      if (this.pendingRequests.get(request.id) !== pending) return;
      this.send(runner.ws, { type: "request-end", id: request.id });
      this.pendingRequests.delete(request.id);
      callbacks.onError("Tunnel request timed out");
    }, timeoutMs);
    pending = {
      id: request.id,
      runnerId,
      port: request.port,
      onResponseStart: callbacks.onResponseStart,
      onResponseData: callbacks.onResponseData,
      onResponseEnd: callbacks.onResponseEnd,
      onError: callbacks.onError,
      timer,
      requestBytes: 0,
      responseBytes: 0,
      requestPaused: false,
    };
    this.replacePendingRequest(request.id, pending);

    this.send(runner.ws, {
      type: "request-start",
      id: request.id,
      port: request.port,
      method: request.method,
      url: request.url,
      headers: request.headers,
      preserveAuth: request.preserveAuth,
      host: request.host,
      capabilityAgeMs: request.capabilityAgeMs,
    });

    return {
      cancel: () => {
        if (this.pendingRequests.get(request.id) !== pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(request.id);
        this.send(runner.ws, { type: "request-end", id: request.id });
      },
    };
  }

  /**
   * Forward a request-body chunk. Returns false once the per-request body
   * limit is exceeded ("Request body too large") or when the frame would push
   * the runner socket past `maxBufferedBytes` (queued bytes PLUS this frame's
   * serialized size; "Tunnel buffer limit exceeded"). In both cases the
   * request is failed and nothing is queued; callers must stop sending.
   */
  sendRequestData(runnerId: string, requestId: string, data: Buffer): boolean {
    const runner = this.runners.get(runnerId);
    if (!runner) return false;
    const pending = this.pendingRequests.get(requestId);
    const owned = pending !== undefined && pending.runnerId === runnerId;
    if (owned) {
      pending.requestBytes += data.length;
      const limit = this.limits.maxRequestBodyBytes;
      if (limit > 0 && pending.requestBytes > limit) {
        this.failPendingRequest(requestId, pending, "Request body too large");
        return false;
      }
    }
    const payload = JSON.stringify({
      type: "request-data",
      id: requestId,
      data: data.toString("binary"),
    } satisfies TunnelServerMessage);
    const ceiling = this.limits.maxBufferedBytes;
    if (ceiling > 0 && socketBufferedAmount(runner.ws) + Buffer.byteLength(payload, "utf8") > ceiling) {
      if (owned) this.failPendingRequest(requestId, pending, "Tunnel buffer limit exceeded");
      return false;
    }
    if (runner.ws.readyState === WebSocket.OPEN) runner.ws.send(payload);
    return true;
  }

  /**
   * Resolve once it is reasonable to send more request-body data: the runner
   * socket has drained below the high-water mark and the runner has not
   * paused this request. Resolves immediately when the request/runner is
   * gone or `signal` aborts (callers re-check state).
   */
  async waitForRequestCapacity(runnerId: string, requestId: string, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const runner = this.runners.get(runnerId);
      const pending = this.pendingRequests.get(requestId);
      if (!runner || !pending || pending.runnerId !== runnerId) return;
      if (!pending.requestPaused && socketBufferedAmount(runner.ws) <= TUNNEL_SEND_HIGH_WATER_BYTES) return;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  /** True while the runner socket holds more than the send high-water mark. */
  isRunnerCongested(runnerId: string): boolean {
    const runner = this.runners.get(runnerId);
    return runner !== undefined && socketBufferedAmount(runner.ws) > TUNNEL_SEND_HIGH_WATER_BYTES;
  }

  /** Resolve once the runner socket drains below the high-water mark (or the runner is gone). */
  async waitForRunnerDrain(runnerId: string): Promise<void> {
    while (this.isRunnerCongested(runnerId)) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  /** Ask the runner to stop reading the local response (viewer is slow). Advisory. */
  pauseResponse(runnerId: string, requestId: string): void {
    const runner = this.runners.get(runnerId);
    if (!runner || this.pendingRequests.get(requestId)?.runnerId !== runnerId) return;
    this.send(runner.ws, { type: "response-pause", id: requestId });
  }

  /** Ask the runner to resume reading the local response. */
  resumeResponse(runnerId: string, requestId: string): void {
    const runner = this.runners.get(runnerId);
    if (!runner || this.pendingRequests.get(requestId)?.runnerId !== runnerId) return;
    this.send(runner.ws, { type: "response-resume", id: requestId });
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
      preserveAuth?: boolean;
      host?: string;
      capabilityAgeMs?: number;
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
    if (this.atInFlightLimit(runnerId, request.id)) {
      callbacks.onError("Too many concurrent tunnel requests for this runner");
      return { cancel() {} };
    }

    let pending!: PendingWsProxy;
    const timer = setTimeout(() => {
      if (this.pendingWs.get(request.id) !== pending) return;
      this.send(runner.ws, { type: "ws-close", id: request.id, code: 1001, reason: "open timeout" });
      this.pendingWs.delete(request.id);
      callbacks.onError("WebSocket open timed out");
    }, timeoutMs);
    pending = {
      id: request.id,
      runnerId,
      onOpened: callbacks.onOpened,
      onData: callbacks.onData,
      onClose: callbacks.onClose,
      onError: callbacks.onError,
      timer,
    };
    this.replacePendingWs(request.id, pending);

    this.send(runner.ws, {
      type: "ws-open",
      id: request.id,
      port: request.port,
      path: request.path,
      protocols: request.protocols,
      headers: request.headers,
      preserveAuth: request.preserveAuth,
      host: request.host,
      capabilityAgeMs: request.capabilityAgeMs,
    });

    return {
      cancel: () => {
        if (this.pendingWs.get(request.id) !== pending) return;
        clearTimeout(pending.timer);
        this.pendingWs.delete(request.id);
        this.send(runner.ws, { type: "ws-close", id: request.id, code: 1001, reason: "cancelled" });
      },
    };
  }

  /**
   * Forward a viewer→runner WebSocket frame. A WebSocket cannot be paused by
   * the runner, so a frame that would push the runner socket past
   * `maxBufferedBytes` (queued bytes PLUS this frame's serialized size) is
   * not sent: the stream is closed with 1013 and false is returned.
   */
  sendWsData(runnerId: string, wsId: string, data: string, binary?: boolean): boolean {
    const runner = this.runners.get(runnerId);
    if (!runner) return false;
    const payload = JSON.stringify({ type: "ws-data", id: wsId, data, binary } satisfies TunnelServerMessage);
    const limit = this.limits.maxBufferedBytes;
    if (limit > 0 && socketBufferedAmount(runner.ws) + Buffer.byteLength(payload, "utf8") > limit) {
      this.log.warn(`[tunnel-relay] Closing tunnel WebSocket ${wsId}: runner send buffer would exceed ${limit} bytes`);
      this.sendWsClose(runnerId, wsId, 1013, "tunnel buffer limit exceeded");
      return false;
    }
    if (runner.ws.readyState === WebSocket.OPEN) runner.ws.send(payload);
    return true;
  }

  sendWsClose(runnerId: string, wsId: string, code?: number, reason?: string): void {
    const pending = this.pendingWs.get(wsId);
    if (!pending) return;

    try {
      const runner = this.runners.get(runnerId);
      if (runner) this.send(runner.ws, { type: "ws-close", id: wsId, code, reason });
    } finally {
      clearTimeout(pending.timer);
      this.pendingWs.delete(wsId);
      pending.onClose(code, reason);
    }
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

  /** Whether opening another stream (other than one replacing `id`) would exceed the per-runner limit. */
  private atInFlightLimit(runnerId: string, id: string): boolean {
    const limit = this.limits.maxInFlightPerRunner;
    if (limit <= 0) return false;
    let count = 0;
    for (const [pendingId, pending] of this.pendingRequests) {
      if (pending.runnerId === runnerId && pendingId !== id) count++;
    }
    for (const [pendingId, pending] of this.pendingWs) {
      if (pending.runnerId === runnerId && pendingId !== id) count++;
    }
    return count >= limit;
  }

  /** Abort a pending HTTP request: tell the runner to stop and surface `reason` to the caller. */
  private failPendingRequest(id: string, pending: PendingProxyRequest, reason: string): void {
    if (this.pendingRequests.get(id) !== pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
    const runner = this.runners.get(pending.runnerId);
    if (runner) this.send(runner.ws, { type: "request-end", id });
    this.log.warn(`[tunnel-relay] Aborting tunnel request ${id} for runner ${pending.runnerId}: ${reason}`);
    pending.onError(reason);
  }

  private replacePendingRequest(id: string, pending: PendingProxyRequest): void {
    const old = this.pendingRequests.get(id);
    if (old) {
      clearTimeout(old.timer);
      this.pendingRequests.delete(id);
      old.onError("Tunnel request replaced");
    }
    this.pendingRequests.set(id, pending);
  }

  private replacePendingWs(id: string, pending: PendingWsProxy): void {
    const old = this.pendingWs.get(id);
    if (old) {
      clearTimeout(old.timer);
      this.pendingWs.delete(id);
      old.onError("WebSocket connection replaced");
    }
    this.pendingWs.set(id, pending);
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
      this.log.warn("[tunnel-relay] Invalid JSON from client");
      return;
    }

    if (!isTunnelClientMessage(msg)) {
      this.log.warn("[tunnel-relay] Invalid message from client");
      return;
    }

    switch (msg.type) {
      case "register":
        await this.handleRegister(ws, msg);
        break;
      case "response-start":
        this.handleResponseStart(ws, msg);
        break;
      case "response-data":
        this.handleResponseData(ws, msg);
        break;
      case "response-data-end":
        this.handleResponseDataEnd(ws, msg);
        break;
      case "response-data-abort":
        this.handleResponseDataAbort(ws, msg);
        break;
      case "request-end":
        this.handleRequestEnd(ws, msg);
        break;
      case "request-pause":
      case "request-resume":
        this.handleRequestFlow(ws, msg);
        break;
      case "ws-opened":
        this.handleWsOpened(ws, msg);
        break;
      case "ws-data":
        this.handleWsData(ws, msg);
        break;
      case "ws-close":
        this.handleWsClose(ws, msg);
        break;
      case "ws-error":
        this.handleWsError(ws, msg);
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
    if (ws.readyState !== WebSocket.OPEN) return;

    // Guard: socket may have closed during the async auth await — abort to avoid a ghost runner.
    // Must run BEFORE any mutation of existing-runner state so a healthy existing runner is preserved.
    if (ws.readyState !== WebSocket.OPEN) {
      this.log.warn("[tunnel-relay] Socket closed during auth, aborting registration:", msg.runnerId);
      return;
    }

    const existing = this.runners.get(msg.runnerId);
    if (existing && existing.userId !== userId) {
      this.log.error("[tunnel-relay] Runner ownership mismatch, rejecting:", msg.runnerId);
      this.send(ws, { type: "error", message: "Runner already registered by another user" });
      ws.close();
      return;
    }

    const pendingErrors = existing ? this.takeRunnerPending(msg.runnerId, "Runner re-registered") : [];
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
    for (const onError of pendingErrors) {
      try {
        onError();
      } catch (error) {
        this.log.error("[tunnel-relay] Pending callback failed during re-registration:", error);
      }
    }
  }

  private handleResponseStart(ws: WebSocket, msg: TunnelResponseStartMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    // The timeout only protects the initial response handshake. Once headers
    // have arrived, the response may legitimately be long-lived (SSE, logs,
    // streaming dev servers), so do not abort it solely because it stays open.
    clearTimeout(pending.timer);
    pending.onResponseStart(msg.statusCode, msg.statusMessage, msg.headers);
  }

  private handleResponseData(ws: WebSocket, msg: TunnelResponseDataMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    const chunk = Buffer.from(msg.data, "binary");
    pending.responseBytes += chunk.length;
    const limit = this.limits.maxResponseBodyBytes;
    if (limit > 0 && pending.responseBytes > limit) {
      this.failPendingRequest(msg.id, pending, "Response body too large");
      return;
    }
    pending.onResponseData(chunk);
  }

  private handleRequestFlow(ws: WebSocket, msg: TunnelRequestPauseMessage | TunnelRequestResumeMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    pending.requestPaused = msg.type === "request-pause";
  }

  private handleResponseDataEnd(ws: WebSocket, msg: TunnelResponseDataEndMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.onResponseEnd();
  }

  private handleResponseDataAbort(ws: WebSocket, msg: TunnelResponseDataAbortMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.onError(msg.reason ?? "Remote stream aborted");
  }

  private handleRequestEnd(ws: WebSocket, msg: TunnelRequestEndMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.onError("Runner aborted request");
  }

  private handleWsOpened(ws: WebSocket, msg: TunnelWsOpenedMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    clearTimeout(pending.timer);
    pending.onOpened(msg.protocol);
  }

  private handleWsData(ws: WebSocket, msg: TunnelWsDataMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    pending.onData(msg.data, msg.binary);
  }

  private handleWsClose(ws: WebSocket, msg: TunnelWsCloseMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    clearTimeout(pending.timer);
    this.pendingWs.delete(msg.id);
    pending.onClose(browserCloseCode(msg.code), msg.reason);
  }

  private handleWsError(ws: WebSocket, msg: TunnelWsErrorMessage): void {
    const pending = this.pendingWs.get(msg.id);
    if (!this.isMessageForPending(ws, pending)) return;
    clearTimeout(pending.timer);
    this.pendingWs.delete(msg.id);
    pending.onError(msg.message);
  }

  private isMessageForPending<T extends PendingProxyRequest | PendingWsProxy>(ws: WebSocket, pending: T | undefined): pending is T {
    return pending !== undefined && this.runners.get(pending.runnerId)?.ws === ws;
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

    for (const onError of this.takeRunnerPending(runnerId, reason)) onError();
  }

  private takeRunnerPending(runnerId: string, reason: string): Array<() => void> {
    const onErrors: Array<() => void> = [];
    for (const [id, pending] of this.pendingRequests) {
      if (pending.runnerId !== runnerId) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      onErrors.push(() => pending.onError(reason));
    }

    for (const [id, pending] of this.pendingWs) {
      if (pending.runnerId !== runnerId) continue;
      clearTimeout(pending.timer);
      this.pendingWs.delete(id);
      onErrors.push(() => pending.onError(reason));
    }
    return onErrors;
  }

  private handleDisconnect(ws: WebSocket): void {
    const runnerId = this.wsToRunner.get(ws);
    if (!runnerId) return;
    this.removeRunner(runnerId, "Runner disconnected");
  }

}
