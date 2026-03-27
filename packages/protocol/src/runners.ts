// ============================================================================
// /runners namespace — Browser runner feed (read-only for clients)
// ============================================================================

import type { RunnerInfo, SocketClientMetadata } from "./shared.js";

export interface RunnersServerToClientEvents {
  /** Full runner list snapshot sent on connection */
  runners: (data: { runners: RunnerInfo[] }) => void;
  /** A runner daemon connected and registered */
  runner_added: (data: RunnerInfo) => void;
  /** A runner daemon disconnected */
  runner_removed: (data: { runnerId: string }) => void;
  /** Runner metadata changed (skills, agents, plugins, hooks) */
  runner_updated: (data: RunnerInfo) => void;
}

export interface RunnersClientToServerEvents {
  // Runners feed is read-only; clients do not emit events
}

export interface RunnersInterServerEvents {
  // Reserved for future Redis adapter usage
}

export interface RunnersSocketData extends SocketClientMetadata {
  userId?: string;
}
