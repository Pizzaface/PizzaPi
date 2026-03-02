// ============================================================================
// Trigger system — shared types for conversation triggers
// ============================================================================

/** The type of condition that fires a trigger */
export type TriggerType =
  | "session_ended"
  | "session_idle"
  | "session_error"
  | "cost_exceeded"
  | "custom_event"
  | "timer";

// ---------------------------------------------------------------------------
// Trigger configuration — one per trigger type
// ---------------------------------------------------------------------------

export interface SessionTriggerConfig {
  sessionIds: string[] | "*";
}

export interface CostTriggerConfig {
  sessionIds: string[] | "*";
  threshold: number;
}

export interface CustomEventTriggerConfig {
  eventName: string;
  fromSessionIds: string[] | "*";
}

export interface TimerTriggerConfig {
  delaySec: number;
  recurring?: boolean;
}

export type TriggerConfig =
  | SessionTriggerConfig
  | CostTriggerConfig
  | CustomEventTriggerConfig
  | TimerTriggerConfig;

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface TriggerDelivery {
  /** "queue" — enqueue a message for the session; "inject" — inject directly into the running conversation */
  mode: "queue" | "inject";
}

// ---------------------------------------------------------------------------
// Persistent record stored server-side
// ---------------------------------------------------------------------------

export interface TriggerRecord {
  id: string;
  type: TriggerType;
  ownerSessionId: string;
  runnerId: string;
  config: TriggerConfig;
  delivery: TriggerDelivery;
  message: string;
  maxFirings?: number;
  firingCount: number;
  expiresAt?: string;
  createdAt: string;
  lastFiredAt?: string;
}

// ---------------------------------------------------------------------------
// Notification sent to the owning session when a trigger fires
// ---------------------------------------------------------------------------

export interface TriggerNotification {
  triggerId: string;
  triggerType: TriggerType;
  message: string;
  sourceSessionId?: string;
  payload?: unknown;
  firedAt: string;
}
