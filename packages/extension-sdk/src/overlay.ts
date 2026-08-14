import type { ServiceModeDef, ServiceSigilDef, ServiceTriggerDef } from "@pizzapi/protocol";

/**
 * `pi.pizzapi` package manifest overlay — schema version 1.
 * See docs/specs/pi-pizzapi-overlay.md for the normative spec.
 */
export interface PizzaPiOverlayV1 {
  schemaVersion: 1;
  services?: PizzaPiServiceDeclaration[];
  agents?: string[];
  rules?: string[];
  mcp?: string;
}

export interface PizzaPiServiceDeclaration {
  id: string;
  label: string;
  entry: string;
  icon?: string;
  panel?: {
    dir: string;
    requires?: PanelVariable[];
  };
  triggers?: string | ServiceTriggerDef[];
  sigils?: string | ServiceSigilDef[];
  sessionModes?: ServiceModeDef[];
}

export type PanelVariable = "PWD" | "SESSION_ID" | "HOME" | "USER" | "PROJECT_DIR";
