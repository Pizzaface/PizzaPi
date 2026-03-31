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
  /** Sigil types declared by services on this runner (from service_announce). */
  sigilDefs?: ServiceSigilDef[];
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
  /**
   * JSON Schema for the trigger's output payload. Defines the shape of data
   * the service emits when firing this trigger. Properties declared here are
   * available as filterable fields — subscribers can set filters on these
   * fields to control which trigger events they receive.
   */
  schema?: Record<string, unknown>;
  /**
   * Configurable parameters that subscribers provide when subscribing.
   * These are passed to the service for its own handling (e.g. "which repo
   * to watch") and are NOT used for server-side delivery filtering.
   * For delivery filtering, subscribers use `filters` based on the output `schema`.
   */
  params?: ServiceTriggerParamDef[];
}

/**
 * A configurable parameter on a trigger type.
 * Subscribers provide values for these when subscribing. These are forwarded
 * to the service for its own use — they do NOT filter trigger delivery.
 */
export interface ServiceTriggerParamDef {
  /** Parameter name — identifies this param to the service */
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
   * Stored as an array; the service receives all selected values.
   */
  multiselect?: boolean;
}

/**
 * A single filter condition on a trigger's output payload.
 * Subscribers specify these to control which trigger events they receive.
 * The `field` must correspond to a property in the trigger's output `schema`.
 */
export interface TriggerFilter {
  /** Field name in the trigger payload to match against */
  field: string;
  /** Expected value(s). Arrays use OR semantics (payload value must be in the set). */
  value: string | number | boolean | Array<string | number | boolean>;
  /**
   * Match operator. Defaults to "eq" (exact match / set membership).
   * "contains" does case-insensitive substring matching on string fields.
   */
  op?: "eq" | "contains";
}

/** How multiple filters combine: "and" = all must match, "or" = any must match. */
export type TriggerFilterMode = "and" | "or";

// ── Service sigil types ───────────────────────────────────────────────────

/**
 * A sigil type that a service can define.
 * Declared in a service's sigils.json (or manifest.json) and forwarded via
 * service_announce so the UI knows how to render [[type:id]] tokens.
 */
export interface ServiceSigilDef {
  /** Sigil type name, e.g. "pr", "commit", "cost" */
  type: string;
  /** Human-readable label, e.g. "Pull Request" */
  label: string;
  /**
   * ID of the service that registered this sigil type.
   * Populated by the daemon during aggregation — not set in sigils.json.
   * Used by the UI to route resolve calls to the correct service panel.
   */
  serviceId?: string;
  /** Optional description of what this sigil represents */
  description?: string;
  /**
   * Lucide icon name for rendering, e.g. "git-pull-request", "git-branch".
   * See https://lucide.dev/icons for the full list.
   */
  icon?: string;
  /**
   * Optional resolve endpoint path (relative to service panel).
   * The UI can call this to enrich display data for a sigil ID.
   * e.g. "/api/resolve/pr/{id}" → resolves PR number to title/status
   */
  resolve?: string;
  /**
   * HTTP port of the resolve server for this sigil type.
   * Populated by the daemon when the service announces a port via
   * announceSigilServer rather than announcePanel (i.e. it runs an HTTP
   * server for resolve calls but does not have a UI panel).
   * The UI uses this to route resolve requests without needing the service
   * to appear in the panels array.
   */
  resolvePort?: number;
  /**
   * JSON Schema for the sigil's params (key-value pairs in [[type:id key=val]]).
   * Defines what params are valid for this sigil type.
   */
  schema?: Record<string, unknown>;
  /**
   * Type aliases — alternative type names that resolve to this sigil.
   * e.g. ["pull-request", "mr"] for a "pr" sigil type.
   */
  aliases?: string[];
}

/** Payload for the service_announce event. */
export interface ServiceAnnounceData {
  serviceIds: string[];
  /** Panels exposed by plugin services (present when ≥1 service has a panel). */
  panels?: ServicePanelInfo[];
  /** Trigger types declared by services on this runner. */
  triggerDefs?: ServiceTriggerDef[];
  /** Sigil types declared by services on this runner. */
  sigilDefs?: ServiceSigilDef[];
}

/** Delta payload for the service_announce_delta event.
 *  Sent instead of a full service_announce when only a subset changed. */
export interface ServiceAnnounceDelta {
  added: {
    serviceIds: string[];
    panels: ServicePanelInfo[];
    triggerDefs: ServiceTriggerDef[];
    sigilDefs: ServiceSigilDef[];
  };
  removed: {
    /** Service IDs that were removed. */
    serviceIds: string[];
    /** Panel serviceIds that were removed. */
    panels: string[];
    /** Trigger types that were removed. */
    triggerDefs: string[];
    /** Sigil types that were removed. */
    sigilDefs: string[];
  };
  updated: {
    panels: ServicePanelInfo[];
    triggerDefs: ServiceTriggerDef[];
    sigilDefs: ServiceSigilDef[];
  };
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
