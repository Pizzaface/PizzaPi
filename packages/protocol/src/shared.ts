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
  /** Active warnings from the runner daemon (e.g. tunnel connection failures). */
  warnings?: string[];
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
