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
  SocketClientMetadata,
  RunnerSkill,
  RunnerAgent,
  RunnerPlugin,
  RunnerHook,
  Attachment,
  ServiceEnvelope,
  ServicePanelInfo,
  ServicePanelLauncher,
  ServicePanelLauncherPosition,
  ServicePanelLauncherSurface,
  ServicePanelPlacement,
  ServiceTriggerDef,
  ServiceTriggerParamDef,
  ServiceSigilDef,
  ServiceModeDef,
  ServiceModeUi,
  ServiceModeChrome,
  ServiceModeVocabulary,
  ServiceModeHome,
  ServiceModeSuggestion,
  ServiceModeArtifacts,
  JsonValue,
  TriggerFilter,
  TriggerFilterMode,
  ServiceAnnounceData,
  ServiceAnnounceDelta,
  TunnelInfo,
} from "./shared.js";

// Unified trigger system (ADR-0002): Source → Event → Route → Delivery
export type {
  SourceKind,
  SourceAuth,
  SourceIdentity,
  ResponseContract,
  TriggerEvent,
  PublishEventInput,
  EventTypeDef,
  DeliverAs,
  RouteOrigin,
  SpawnSpec,
  RouteTarget,
  Route,
  RouteInput,
  DeliveryStatus,
  Delivery,
  DeliveryView,
} from "./events.js";
export {
  isValidEventType,
  routeMatchesOwner,
  isSourceIdentity,
  isTriggerEvent,
  isRouteTarget,
  isDeliveryStatus,
  renderEventText,
} from "./events.js";

// Session mode UI resolution (shared across server, UI, CLI)
export {
  resolveModeUi,
  isArtifactPath,
  findSessionMode,
  surfaceVisibleInMode,
  cwdInWorkspace,
  DEFAULT_ARTIFACT_EXTENSIONS,
} from "./mode-ui.js";
export type { ResolvedModeUi } from "./mode-ui.js";

// Password validation (shared across server, UI, CLI)
export {
  MAX_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS,
  PASSWORD_REQUIREMENTS_SUMMARY,
  validatePassword,
  isValidPassword,
} from "./password.js";
export type { PasswordCheck, PasswordCheckItem } from "./password.js";

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
  TriggerSubscriptionEntry,
  TriggerSubscriptionsSnapshot,
  TriggerSubscriptionDelta,
  TriggerSubscriptionsApplied,
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

export type {
  SessionMetaState, MetaRelayEvent, MetaTodoItem, MetaTokenUsage, MetaProviderUsage,
  MetaModelInfo, MetaPendingQuestion, MetaPendingPlan, MetaRetryState,
  MetaPluginTrustPrompt, MetaMcpReport, MetaGoalStatus,
  MetaPendingApproval, ApprovalRequest, ApprovalDecision, ApprovalField, ApprovalAction,
} from "./meta.js";
export { defaultMetaState, isMetaRelayEvent, metaEventToPatch, META_RELAY_EVENT_TYPES } from "./meta.js";

export {
  SOCKET_PROTOCOL_VERSION,
  parseSemverTriplet,
  compareSemver,
  isSocketProtocolCompatible,
} from "./version.js";

// Runtime payload guards for critical external boundaries
export {
  isRecord,
  parseViewerEventEnvelope,
  parseViewerConnectedEnvelope,
  parseHubStateSnapshot,
  parseHubMetaEvent,
  parseMetaRelayEvent,
  parseSpawnResponse,
  normalizeSessionMetaState,
} from "./payload-guards.js";
export type {
  ViewerEventEnvelope,
  ViewerConnectedEnvelope,
  SpawnResponse,
} from "./payload-guards.js";

// /runners namespace (Browser runner feed)
export type {
  RunnersClientToServerEvents,
  RunnersServerToClientEvents,
  RunnersInterServerEvents,
  RunnersSocketData,
} from "./runners.js";
