// ============================================================================
// @pizzapi/protocol — Typed Socket.IO event interfaces
//
// Re-exports all namespace event maps and shared types.
// ============================================================================

// Shared types
export type {
  SessionInfo,
  ModelInfo,
  RunnerInfo,
  RunnerSkill,
  Attachment,
} from "./shared.js";

// /relay namespace (TUI ↔ Server)
export type {
  RelayClientToServerEvents,
  RelayServerToClientEvents,
  RelayInterServerEvents,
  RelaySocketData,
} from "./relay.js";

// /viewer namespace (Browser viewer ↔ Server)
export type {
  ViewerClientToServerEvents,
  ViewerServerToClientEvents,
  ViewerInterServerEvents,
  ViewerSocketData,
} from "./viewer.js";

// /runner namespace (Runner daemon ↔ Server)
export type {
  RunnerClientToServerEvents,
  RunnerServerToClientEvents,
  RunnerInterServerEvents,
  RunnerSocketData,
} from "./runner.js";

// /terminal namespace (Browser terminal viewer ↔ Server)
export type {
  TerminalClientToServerEvents,
  TerminalServerToClientEvents,
  TerminalInterServerEvents,
  TerminalSocketData,
} from "./terminal.js";

// /hub namespace (Session list feed)
export type {
  HubClientToServerEvents,
  HubServerToClientEvents,
  HubInterServerEvents,
  HubSocketData,
} from "./hub.js";
