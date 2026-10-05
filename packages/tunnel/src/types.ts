// ── Registration ─────────────────────────────────────────────────────────────

export interface TunnelRegisterMessage {
  type: "register";
  runnerId: string;
  apiKey: string;
}

export interface TunnelRegisteredMessage {
  type: "registered";
  runnerId: string;
}

export interface TunnelErrorMessage {
  type: "error";
  message: string;
}

// ── HTTP streaming ──────────────────────────────────────────────────────────
//
// HTTP body chunks use Latin-1 ("binary") encoding in JSON strings.
// This preserves arbitrary byte values 0x00–0xFF without base64 overhead.
//
// WebSocket binary frames use base64 encoding because WS frames may contain
// arbitrary binary data. Text frames are passed as-is.

export interface TunnelRequestStartMessage {
  type: "request-start";
  id: string;
  port: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Host-based tunnels: forward the app's own Cookie/Authorization to the
   * local service (the tunnel origin is dedicated — those credentials belong
   * to the app, not the relay). Old runners ignore this and keep stripping.
   */
  preserveAuth?: boolean;
  /**
   * Host-based tunnels: the tunnel origin host (e.g. "abc123.t.example.com")
   * that the local service should see as its Host header. When present the
   * client uses this instead of the default "127.0.0.1:<port>", so apps that
   * construct absolute URLs from `Host` produce correct tunnel-origin URLs.
   * Absent for path-based tunnels — those keep "127.0.0.1:<port>".
   */
  host?: string;
  /**
   * Capability-authenticated requests (signed tunnel token or host label):
   * milliseconds since the relay minted that capability. The runner rejects
   * the request when the port's current exposure began after the capability
   * was issued — an unexposed-then-reused port must not revive old links.
   * Relative age (not a timestamp) keeps this immune to relay/runner clock
   * skew. Absent for cookie/API-key requests, which are authorized live.
   * Old runners ignore it.
   */
  capabilityAgeMs?: number;
}

export interface TunnelRequestDataMessage {
  type: "request-data";
  id: string;
  /** Request body chunk, binary-encoded string. */
  data: string;
}

export interface TunnelRequestDataEndMessage {
  type: "request-data-end";
  id: string;
}

/** Server tells client the viewer disconnected — abort the local request. */
export interface TunnelRequestEndMessage {
  type: "request-end";
  id: string;
}

export interface TunnelResponseStartMessage {
  type: "response-start";
  id: string;
  statusCode: number;
  statusMessage: string;
  /** Array values preserve multi-value headers (e.g. multiple Set-Cookie). */
  headers: Record<string, string | string[]>;
}

export interface TunnelResponseDataMessage {
  type: "response-data";
  id: string;
  /** Response body chunk, binary-encoded string. */
  data: string;
}

export interface TunnelResponseDataEndMessage {
  type: "response-data-end";
  id: string;
}

/**
 * Client → server: mid-stream failure (error / aborted / premature close).
 * Server should destroy/error the downstream response instead of ending it cleanly.
 */
export interface TunnelResponseDataAbortMessage {
  type: "response-data-abort";
  id: string;
  reason?: string;
}

// ── Flow control ────────────────────────────────────────────────────────────
//
// Optional, advisory backpressure for HTTP bodies. Peers that predate these
// messages ignore them; both sides additionally enforce hard buffer limits,
// so an old peer degrades to deterministic termination instead of unbounded
// queueing.

/** Server → client: viewer is not draining the response — pause reading the local response. */
export interface TunnelResponsePauseMessage {
  type: "response-pause";
  id: string;
}

/** Server → client: viewer drained — resume reading the local response. */
export interface TunnelResponseResumeMessage {
  type: "response-resume";
  id: string;
}

/** Client → server: local service is not draining the request body — stop sending request-data. */
export interface TunnelRequestPauseMessage {
  type: "request-pause";
  id: string;
}

/** Client → server: local service drained — resume sending request-data. */
export interface TunnelRequestResumeMessage {
  type: "request-resume";
  id: string;
}

// ── WebSocket proxying ──────────────────────────────────────────────────────

export interface TunnelWsOpenMessage {
  type: "ws-open";
  id: string;
  port: number;
  path: string;
  protocols?: string[];
  headers: Record<string, string>;
  /** See TunnelRequestStartMessage.preserveAuth. */
  preserveAuth?: boolean;
  /** See TunnelRequestStartMessage.host. */
  host?: string;
  /** See TunnelRequestStartMessage.capabilityAgeMs. */
  capabilityAgeMs?: number;
}

export interface TunnelWsOpenedMessage {
  type: "ws-opened";
  id: string;
  protocol?: string;
}

export interface TunnelWsDataMessage {
  type: "ws-data";
  id: string;
  data: string;
  binary?: boolean;
}

export interface TunnelWsCloseMessage {
  type: "ws-close";
  id: string;
  code?: number;
  reason?: string;
}

export interface TunnelWsErrorMessage {
  type: "ws-error";
  id: string;
  message: string;
}

// ── Keepalive ───────────────────────────────────────────────────────────────

export interface TunnelPingMessage {
  type: "ping";
}

export interface TunnelPongMessage {
  type: "pong";
}

// ── Union types ─────────────────────────────────────────────────────────────

export type TunnelClientMessage =
  | TunnelRegisterMessage
  | TunnelResponseStartMessage
  | TunnelResponseDataMessage
  | TunnelResponseDataEndMessage
  | TunnelResponseDataAbortMessage
  | TunnelRequestEndMessage
  | TunnelRequestPauseMessage
  | TunnelRequestResumeMessage
  | TunnelWsOpenedMessage
  | TunnelWsDataMessage
  | TunnelWsCloseMessage
  | TunnelWsErrorMessage
  | TunnelPongMessage;

export type TunnelServerMessage =
  | TunnelRegisteredMessage
  | TunnelErrorMessage
  | TunnelRequestStartMessage
  | TunnelRequestDataMessage
  | TunnelRequestDataEndMessage
  | TunnelRequestEndMessage
  | TunnelResponsePauseMessage
  | TunnelResponseResumeMessage
  | TunnelWsOpenMessage
  | TunnelWsDataMessage
  | TunnelWsCloseMessage
  | TunnelPingMessage;
