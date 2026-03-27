// ============================================================================
// /relay namespace — TUI (CLI agent) ↔ Server
// ============================================================================

import type { Attachment, SocketClientMetadata } from "./shared.js";

// ---------------------------------------------------------------------------
// Client → Server (TUI sends to server)
// ---------------------------------------------------------------------------

export interface RelayClientToServerEvents {
  /** TUI registers a new or existing session */
  register: (data: {
    sessionId?: string;
    cwd: string;
    ephemeral?: boolean;
    collabMode?: boolean;
    sessionName?: string | null;
    /** Parent session ID for child→parent linking (trigger system). */
    parentSessionId?: string | null;
  }) => void;

  /** TUI forwards an agent event (heartbeat, message_update, etc.)
   *  Meta event discrimination is handled by isMetaRelayEvent from meta.ts.
   */
  event: (data: {
    sessionId: string;
    token: string;
    event: unknown;
    seq?: number;
  }) => void;

  /** TUI signals a session has ended */
  session_end: (data: {
    sessionId: string;
    token: string;
  }) => void;

  /** TUI responds to a previously-received exec command */
  exec_result: (data: {
    id: string;
    ok: boolean;
    command: string;
    result?: unknown;
    error?: string;
  }) => void;

  /** TUI sends an inter-session message */
  session_message: (data: {
    token: string;
    targetSessionId: string;
    message: string;
    /** When "input", deliver as agent input (starts a new turn). Otherwise, deliver to message bus. */
    deliverAs?: "input";
  }) => void;

  /** Child session fires a trigger destined for its parent */
  session_trigger: (data: {
    token: string;
    trigger: {
      type: string;
      sourceSessionId: string;
      sourceSessionName?: string;
      targetSessionId: string;
      payload: Record<string, unknown>;
      deliverAs: "steer" | "followUp";
      expectsResponse: boolean;
      triggerId: string;
      timeoutMs?: number;
      ts: string;
    };
  }) => void;

  /** Parent sends a trigger response back to the child */
  trigger_response: (data: {
    token: string;
    triggerId: string;
    response: string;
    action?: string;
    targetSessionId: string;
  }) => void;

  /** Parent requests cleanup of a completed child session.
   *  The server validates the parent↔child relationship and tears down the child. */
  cleanup_child_session: (data: {
    token: string;
    childSessionId: string;
  }, ack?: (result: { ok: boolean; error?: string }) => void) => void;

  /** Parent requests delinking of all child sessions (e.g. on /new).
   *  The server clears child→parent links and notifies children their parent is gone. */
  delink_children: (data: {
    token: string;
    epoch?: number;
  }, ack?: (result: { ok: boolean; error?: string }) => void) => void;

  /** Child requests severing its own parent link (e.g. on /new).
   *  The server removes the child from the parent's children set and clears
   *  parentSessionId on the child's Redis session hash. */
  delink_own_parent: (data: {
    token: string;
    /** Old parent session ID captured before clearing rctx.parentSessionId.
     *  Used by the server to scrub stale children-set entries when
     *  parentSessionId is already null in Redis (e.g. /new while disconnected). */
    oldParentId?: string | null;
  }, ack?: (result: { ok: boolean; error?: string }) => void) => void;
}

// ---------------------------------------------------------------------------
// Server → Client (Server sends to TUI)
// ---------------------------------------------------------------------------

export interface RelayServerToClientEvents {
  /** Confirms session registration */
  registered: (data: {
    sessionId: string;
    token: string;
    shareUrl: string;
    isEphemeral: boolean;
    collabMode: boolean;
    /** Confirmed parent session ID (null if not a child session). */
    parentSessionId?: string | null;
    /** Server wall-clock time (ms since epoch) for clock-offset calculation. */
    serverTime?: number;
    /**
     * True when parentSessionId is null because the parent explicitly delinked
     * this child (ran /new). Absent or false for transient parent-offline cases.
     * The client uses this to distinguish "permanent delink" from "retry later".
     */
    wasDelinked?: boolean;
  }) => void;

  /** Acknowledges receipt of an event with its sequence number */
  event_ack: (data: {
    sessionId: string;
    seq: number;
  }) => void;

  /** Notifies TUI that a viewer connected */
  connected: (data: Record<string, never>) => void;

  /** Delivers user input from the web viewer */
  input: (data: {
    text: string;
    attachments?: Attachment[];
    client?: string;
    deliverAs?: "steer" | "followUp";
  }) => void;

  /** Instructs TUI to switch model */
  model_set: (data: {
    provider: string;
    modelId: string;
  }) => void;

  /** Remote command execution request from viewer */
  exec: (data: {
    id: string;
    command: string;
    [key: string]: unknown;
  }) => void;

  /** Delivers an inter-session message */
  session_message: (data: {
    fromSessionId: string;
    message: string;
    ts: string;
  }) => void;

  /** Error delivering an inter-session message */
  session_message_error: (data: {
    targetSessionId: string;
    error: string;
  }) => void;

  /** Delivers a trigger from a child to the target session */
  session_trigger: (data: {
    trigger: {
      type: string;
      sourceSessionId: string;
      sourceSessionName?: string;
      targetSessionId: string;
      payload: Record<string, unknown>;
      deliverAs: "steer" | "followUp";
      expectsResponse: boolean;
      triggerId: string;
      timeoutMs?: number;
      ts: string;
    };
  }) => void;

  /** Delivers a trigger response back to the source child.
   *  May also be forwarded via the parent session when a human viewer reply
   *  is routed through the parent CLI. */
  trigger_response: (data: {
    triggerId: string;
    response: string;
    /** Optional action metadata (approve/cancel/ack/followUp, etc.). */
    action?: string;
    /** Optional child target session ID when forwarded via parent. */
    targetSessionId?: string;
  }) => void;

  /** Notifies that a session has expired */
  session_expired: (data: {
    sessionId: string;
  }) => void;

  /** Notifies a child that its parent has delinked (e.g. started a new session).
   *  Children receiving this should cancel any pending triggers awaiting a parent response.
   *  The optional ack lets the server confirm delivery before acknowledging the
   *  parent's delink_children request. */
  parent_delinked: (data: {
    parentSessionId: string;
  }, ack?: (result: { ok: boolean }) => void) => void;

  /** Generic error */
  error: (data: {
    message: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Inter-server events (Redis adapter cross-server communication)
// ---------------------------------------------------------------------------

export interface RelayInterServerEvents {
  // Reserved for future Redis adapter usage
}

// ---------------------------------------------------------------------------
// Per-socket metadata
// ---------------------------------------------------------------------------

export interface RelaySocketData extends SocketClientMetadata {
  sessionId?: string;
  token?: string;
  cwd?: string;
  userId?: string;
}
