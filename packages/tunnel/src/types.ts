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
  headers: Record<string, string>;
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

// ── WebSocket proxying ──────────────────────────────────────────────────────

export interface TunnelWsOpenMessage {
  type: "ws-open";
  id: string;
  port: number;
  path: string;
  protocols?: string[];
  headers: Record<string, string>;
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
  | TunnelRequestEndMessage
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
  | TunnelWsOpenMessage
  | TunnelWsDataMessage
  | TunnelWsCloseMessage
  | TunnelPingMessage;
