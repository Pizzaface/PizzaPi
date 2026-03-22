// ============================================================================
// /hub namespace — Session list feed (read-only for clients)
// ============================================================================

import type { ModelInfo, SessionInfo } from "./shared.js";
import type { SessionMetaState, MetaRelayEvent } from "./meta.js";

// ---------------------------------------------------------------------------
// Server → Client (Server sends session list updates to browsers)
// ---------------------------------------------------------------------------

export interface HubServerToClientEvents {
  /** Full session list snapshot */
  sessions: (data: {
    sessions: SessionInfo[];
  }) => void;

  /** A new session was added */
  session_added: (data: SessionInfo) => void;

  /** A session was removed */
  session_removed: (data: {
    sessionId: string;
  }) => void;

  /** A session's status changed */
  session_status: (data: {
    sessionId: string;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    sessionName: string | null;
    model: ModelInfo | null;
    runnerId?: string;
    runnerName?: string | null;
  }) => void;

  state_snapshot: (data: { sessionId: string; state: SessionMetaState }) => void;
  meta_event: (data: { sessionId: string; version: number } & MetaRelayEvent) => void;
}

// ---------------------------------------------------------------------------
// Client → Server (hub is read-only — no client events)
// ---------------------------------------------------------------------------

export interface HubClientToServerEvents {
  subscribe_session_meta:   (data: { sessionId: string }) => void;
  unsubscribe_session_meta: (data: { sessionId: string }) => void;
}

// ---------------------------------------------------------------------------
// Inter-server events
// ---------------------------------------------------------------------------

export interface HubInterServerEvents {
  // Reserved for future Redis adapter usage
}

// ---------------------------------------------------------------------------
// Per-socket metadata
// ---------------------------------------------------------------------------

export interface HubSocketData {
  userId?: string;
}
