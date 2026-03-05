// ============================================================================
// /relay namespace — TUI (CLI agent) ↔ Server
// ============================================================================

import type { Attachment } from "./shared.js";

// ---------------------------------------------------------------------------
// Session status query/response payload
// ---------------------------------------------------------------------------

export interface SessionStatusPayload {
  sessionId: string;
  status: "active" | "idle" | "completed" | "error" | "unknown";
  model?: string;
  sessionName?: string;
  parentSessionId?: string | null;
  childSessionIds?: string[];
  lastActivity?: string;
}

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
    parentSessionId?: string | null;
  }) => void;

  /** TUI forwards an agent event (heartbeat, message_update, etc.) */
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
    metadata?: Record<string, unknown>;
  }) => void;

  /** TUI reports session completion to its parent session */
  session_completion: (data: {
    sessionId: string;
    token: string;
    result: string;
    tokenUsage?: Record<string, unknown>;
    error?: string;
  }) => void;

  /** TUI queries the status of another session */
  session_status_query: (data: {
    requestId: string;
    targetSessionId: string;
  }) => void;

  /** TUI joins a named channel */
  channel_join: (data: {
    channelId: string;
  }) => void;

  /** TUI leaves a named channel */
  channel_leave: (data: {
    channelId: string;
  }) => void;

  /** TUI sends a message to all members of a channel */
  channel_message: (data: {
    channelId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => void;
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
    metadata?: Record<string, unknown>;
  }) => void;

  /** Delivers a completion notification from a child session */
  session_completion: (data: {
    sessionId: string;
    parentSessionId: string;
    result: string;
    tokenUsage?: Record<string, unknown>;
    error?: string;
  }) => void;

  /** Error delivering an inter-session message */
  session_message_error: (data: {
    targetSessionId: string;
    error: string;
  }) => void;

  /** Notifies that a session has expired */
  session_expired: (data: {
    sessionId: string;
  }) => void;

  /** Response to a session status query */
  session_status_response: (data: {
    requestId: string;
    status: SessionStatusPayload | null;
  }) => void;

  /** Delivers a channel message broadcast */
  channel_message: (data: {
    channelId: string;
    fromSessionId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => void;

  /** Channel membership update (join/leave notification) */
  channel_membership: (data: {
    channelId: string;
    members: string[];
    event: "joined" | "left";
    sessionId: string;
  }) => void;

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

export interface RelaySocketData {
  sessionId?: string;
  token?: string;
  cwd?: string;
  userId?: string;
}
