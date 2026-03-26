// ============================================================================
// Shared types used across multiple Socket.IO namespaces
// ============================================================================

/** Common metadata extracted from Socket.IO handshake auth payloads. */
export interface SocketClientMetadata {
  /** Optional client package/app version reported at connect time. */
  clientVersion?: string;
  /** Optional handshake protocol version reported by the client. */
  clientProtocolVersion?: number;
  /** Derived compatibility flag on the server (true when compatible or unknown). */
  protocolCompatible?: boolean;
}

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
  /** Worker type — "pi" for the standard pi agent, "claude-code" for the
   *  Claude Code CLI worker.  Derived from the session's last heartbeat.
   *  Undefined for sessions that have never sent a heartbeat. */
  workerType?: "pi" | "claude-code";
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
  /** Trigger types declared by services on this runner (from service_announce). */
  triggerDefs?: ServiceTriggerDef[];
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

// ── Service trigger types ─────────────────────────────────────────────────────

/**
 * A trigger type that a service can emit.
 * Declared in a service's manifest.json and forwarded via service_announce
 * so agents and the UI can discover what triggers are available.
 */
export interface ServiceTriggerDef {
  /** Namespaced trigger type, e.g. "godmother:idea_moved" */
  type: string;
  /** Human-readable label, e.g. "Idea Status Changed" */
  label: string;
  /** Optional description of when/why this trigger fires */
  description?: string;
  /** Optional JSON Schema for the trigger payload */
  schema?: Record<string, unknown>;
  /**
   * Configurable parameters that subscribers provide when subscribing.
   * At broadcast time, delivery is filtered: a subscriber only receives the
   * trigger if every param they specified matches the corresponding payload field.
   */
  params?: ServiceTriggerParamDef[];
}

/**
 * A configurable parameter on a trigger type.
 * Subscribers provide values for these when subscribing, and the broadcast
 * delivery path filters based on matches.
 */
export interface ServiceTriggerParamDef {
  /** Parameter name — must match a key in the trigger payload */
  name: string;
  /** Human-readable label for the UI */
  label: string;
  /** Value type */
  type: "string" | "number" | "boolean";
  /** Optional description */
  description?: string;
  /** Whether the subscriber must provide this param */
  required?: boolean;
  /** Default value if not provided */
  default?: string | number | boolean;
  /** Allowed values — renders as a dropdown in the UI */
  enum?: Array<string | number | boolean>;
  /**
   * Allow selecting multiple enum values. Requires `enum` to be set.
   * Stored as an array; at delivery time the trigger matches if the payload
   * value is contained in the subscriber's selected set (OR semantics).
   */
  multiselect?: boolean;
}

/** Payload for the service_announce event. */
export interface ServiceAnnounceData {
  serviceIds: string[];
  /** Panels exposed by plugin services (present when ≥1 service has a panel). */
  panels?: ServicePanelInfo[];
  /** Trigger types declared by services on this runner. */
  triggerDefs?: ServiceTriggerDef[];
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
