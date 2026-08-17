// @pizzapi/extension-sdk — public authoring contract for PizzaPi overlay packages.
// See docs/specs/pi-pizzapi-overlay.md for the normative spec.

export type {
  PizzaPiSocket,
  ServiceHandler,
  ServiceInitOptions,
  ServiceEnvelope,
  ReconcileResult,
  ReconcileOptions,
  TriggerSubscriptionEntry,
  TriggerSubscriptionDelta,
} from "./service.js";

export type {
  PizzaPiOverlayV1,
  PizzaPiServiceDeclaration,
  PanelVariable,
} from "./overlay.js";
export type { ServicePanelPlacement } from "@pizzapi/protocol";
export type { ServicePanelLauncherSurface, ServicePanelLauncherPosition } from "./overlay.js";

export type { PizzaPiHostInfo, PizzaPiHostAPI } from "./host.js";
export { isPizzaPiHostInfo, detectPizzaPiHost, onPizzaPiHost, sendServiceMessage, requestApproval } from "./host.js";
export type { ApprovalRequest, ApprovalDecision, ApprovalField, ApprovalAction } from "@pizzapi/protocol";

// Re-exported protocol declaration types required by the public service contract.
export type { ServiceTriggerDef, ServiceSigilDef, ServicePanelInfo, ServiceTriggerParamDef } from "@pizzapi/protocol";
