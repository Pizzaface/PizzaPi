// ============================================================================
// Shared types used across multiple Socket.IO namespaces
// ============================================================================

/** Information about a connected session, used in hub feed and session lists */
export interface SessionInfo {
  sessionId: string;
  shareUrl: string;
  cwd: string;
  startedAt: string;
  viewerCount?: number;
  userId?: string;
  userName?: string;
  sessionName: string | null;
  isEphemeral: boolean;
  expiresAt?: string | null;
  isActive: boolean;
  lastHeartbeatAt: string | null;
  model: ModelInfo | null;
  runnerId: string | null;
  runnerName: string | null;
  /** ID of the parent session that spawned this one, or null for top-level. */
  parentSessionId?: string | null;
}

/** Model provider and identifier */
export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
}

/** A summary of a single hook type active on the runner */
export interface RunnerHook {
  /** Hook lifecycle type (e.g. "PreToolUse", "PostToolUse", "Input") */
  type: string;
  /** Script basenames configured for this hook type */
  scripts: string[];
}

/** Runner daemon metadata */
export interface RunnerInfo {
  runnerId: string;
  name: string | null;
  roots: string[];
  sessionCount: number;
  skills: RunnerSkill[];
  agents: RunnerAgent[];
  plugins?: RunnerPlugin[];
  hooks?: RunnerHook[];
  version: string | null;
  /** Node.js process.platform value (e.g. "darwin", "linux", "win32") */
  platform?: string | null;
  /** Service IDs available on this runner (cached from last service_announce). */
  serviceIds?: string[];
  /** Panel metadata for services that expose a UI panel. */
  panels?: ServicePanelInfo[];
}

/** A discovered Claude Code plugin on a runner */
export interface RunnerPlugin {
  name: string;
  description: string;
  rootPath: string;
  commands: { name: string; description?: string; argumentHint?: string }[];
  hookEvents: string[];
  skills: { name: string; dirPath: string }[];
  agents?: { name: string }[];
  rules?: { name: string }[];
  hasMcp: boolean;
  hasAgents: boolean;
  hasLsp: boolean;
  version?: string;
  author?: string;
}

/** A skill available on a runner */
export interface RunnerSkill {
  name: string;
  description: string;
  filePath: string;
}

/** An agent definition available on a runner */
export interface RunnerAgent {
  name: string;
  description: string;
  filePath: string;
}

/** File attachment metadata (used in input messages) */
export interface Attachment {
  attachmentId?: string;
  mediaType?: string;
  filename?: string;
  url?: string;
}

/** Generic relay protocol envelope for service messages.
 *  Enables runner services to communicate with viewers without
 *  the relay needing to understand service-specific semantics. */
export interface ServiceEnvelope {
  serviceId: string;
  type: string;
  requestId?: string;
  /** Attached by the relay when forwarding viewer→runner, so services can route responses back. */
  sessionId?: string;
  payload: unknown;
}

// ── Service panel types ───────────────────────────────────────────────────────

/** Metadata for a service panel announced by the runner. */
export interface ServicePanelInfo {
  /** Must match the runner service's `id`. */
  serviceId: string;
  /** Local port the service's HTTP server is listening on (proxied via tunnel). */
  port: number;
  /** Human-readable label for the panel button. */
  label: string;
  /** Lucide icon name (e.g. "activity", "cpu"). */
  icon: string;
}

/** Payload for the service_announce event. */
export interface ServiceAnnounceData {
  serviceIds: string[];
  /** Panels exposed by plugin services (present when ≥1 service has a panel). */
  panels?: ServicePanelInfo[];
}

// ── Tunnel service types ──────────────────────────────────────────────────────

/** Information about an exposed tunnel port. */
export interface TunnelInfo {
  port: number;
  name?: string;
  /** Relay tunnel URL fragment — actual URL is /api/tunnel/{sessionId}/{port}/ */
  url: string;
  /**
   * When true, this tunnel was auto-registered by the runner daemon (e.g. a
   * service panel port) and is not user-managed. The UI should hide it from
   * the TunnelPanel tunnel list.
   */
  pinned?: boolean;
}

/** Server → Runner: HTTP proxy request forwarded from an authenticated viewer. */
export interface TunnelRequestData {
  requestId: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Request body, base64-encoded. Absent for bodyless methods (GET, HEAD, DELETE). */
  body?: string;
}

/** Runner → Server: HTTP proxy response from the local service. */
export interface TunnelResponseData {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  /** Response body, base64-encoded. */
  body: string;
  /** Set when the proxy itself failed (connection refused, timeout, etc.). */
  error?: string;
}

// ── Tunnel WebSocket proxy types ──────────────────────────────────────────────

/**
 * Server → Runner: open a WebSocket connection to a local port.
 * The runner should connect to ws://127.0.0.1:{port}{path} and bridge
 * frames back via tunnel_ws_data events.
 */
export interface TunnelWsOpenData {
  /** Unique ID for this WebSocket tunnel connection. */
  tunnelWsId: string;
  port: number;
  /** Path + query string (e.g. "/__vite_hmr?token=abc"). */
  path: string;
  /** WebSocket sub-protocols requested by the client (Sec-WebSocket-Protocol). */
  protocols?: string[];
  /** Forwarded request headers (stripped of hop-by-hop and auth headers). */
  headers: Record<string, string>;
}

/**
 * Bidirectional: carries a WebSocket frame between server and runner.
 * Used in both directions (server→runner for client messages, runner→server
 * for local service messages).
 */
export interface TunnelWsDataPayload {
  tunnelWsId: string;
  /** Frame data, base64-encoded for binary frames, plain string for text frames. */
  data: string;
  /** true when data is base64-encoded binary; false/absent for text frames. */
  binary?: boolean;
}

/**
 * Bidirectional: close a tunneled WebSocket connection.
 * Either side can initiate (viewer disconnect or local service disconnect).
 */
export interface TunnelWsCloseData {
  tunnelWsId: string;
  /** WebSocket close code (e.g. 1000 for normal). */
  code?: number;
  /** WebSocket close reason string. */
  reason?: string;
}

/**
 * Runner → Server: report a WebSocket error (connection refused, etc.).
 * The server should close the viewer's WebSocket with an appropriate error.
 */
export interface TunnelWsErrorData {
  tunnelWsId: string;
  message: string;
}

/**
 * Runner → Server: confirms the local WebSocket connection is open.
 * The server completes the WebSocket handshake with the viewer.
 */
export interface TunnelWsOpenedData {
  tunnelWsId: string;
  /** The sub-protocol selected by the local service (if any). */
  protocol?: string;
}
