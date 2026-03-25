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
  payload: unknown;
}

// ── Tunnel service types ──────────────────────────────────────────────────────

/** Information about an exposed tunnel port. */
export interface TunnelInfo {
  port: number;
  name?: string;
  /** Relay tunnel URL fragment — actual URL is /api/tunnel/{sessionId}/{port}/ */
  url: string;
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
