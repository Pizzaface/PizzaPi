// ============================================================================
// /viewer namespace — Browser viewer ↔ Server
// ============================================================================

import type { Attachment } from "./shared.js";
import type { TriggerType, TriggerConfig, TriggerDelivery, TriggerRecord, TriggerNotification } from "./triggers.js";

// ---------------------------------------------------------------------------
// Server → Client (Server sends to browser viewer)
// ---------------------------------------------------------------------------

export interface ViewerServerToClientEvents {
  /** Confirms viewer connection to a session */
  connected: (data: {
    sessionId: string;
    lastSeq?: number;
    replayOnly?: boolean;
    isActive?: boolean;
    lastHeartbeatAt?: string | null;
    sessionName?: string | null;
  }) => void;

  /** Forwards an agent event to the viewer */
  event: (data: {
    event: unknown;
    seq?: number;
    replay?: boolean;
  }) => void;

  /** Notifies the viewer that the TUI disconnected */
  disconnected: (data: {
    reason: string;
  }) => void;

  /** Forwards an exec result back to the viewer */
  exec_result: (data: {
    id: string;
    ok: boolean;
    command: string;
    result?: unknown;
    error?: string;
  }) => void;

  /** Generic error */
  error: (data: {
    message: string;
  }) => void;

  /** Trigger registered (or updated) for this session */
  trigger_registered: (data: {
    triggers: TriggerRecord[];
  }) => void;

  /** Trigger cancelled for this session */
  trigger_cancelled: (data: {
    triggerId: string;
    triggers: TriggerRecord[];
  }) => void;

  /** Full trigger list for this session */
  trigger_list: (data: {
    triggers: TriggerRecord[];
  }) => void;

  /** A trigger fired for this session */
  trigger_fired: (data: TriggerNotification & {
    delivery: TriggerDelivery;
    triggers: TriggerRecord[];
  }) => void;
}

// ---------------------------------------------------------------------------
// Client → Server (Browser viewer sends to server)
// ---------------------------------------------------------------------------

export interface ViewerClientToServerEvents {
  /** Viewer greeting — triggers TUI capabilities push */
  connected: (data: Record<string, never>) => void;

  /** Request a fresh snapshot resync */
  resync: (data: Record<string, never>) => void;

  /** Send user input to TUI (collab mode) */
  input: (data: {
    text: string;
    attachments?: Attachment[];
    client?: string;
    deliverAs?: "steer" | "followUp";
  }) => void;

  /** Instruct TUI to switch model (collab mode) */
  model_set: (data: {
    provider: string;
    modelId: string;
  }) => void;

  /** Send a remote exec command to TUI (collab mode) */
  exec: (data: {
    id: string;
    command: string;
    [key: string]: unknown;
  }) => void;

  /** Register a new trigger for the viewed session */
  register_trigger: (data: {
    type: TriggerType;
    config: TriggerConfig;
    delivery?: TriggerDelivery;
    message?: string;
    maxFirings?: number;
    expiresAt?: string;
  }) => void;

  /** Cancel/delete a trigger for the viewed session */
  cancel_trigger: (data: {
    triggerId: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Inter-server events
// ---------------------------------------------------------------------------

export interface ViewerInterServerEvents {
  // Reserved for future Redis adapter usage
}

// ---------------------------------------------------------------------------
// Per-socket metadata
// ---------------------------------------------------------------------------

export interface ViewerSocketData {
  sessionId?: string;
  userId?: string;
  userName?: string;
}
