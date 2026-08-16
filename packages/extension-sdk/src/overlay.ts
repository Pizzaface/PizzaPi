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
  /**
   * Session mode ids this service's UI surfaces (panel, triggers) are scoped
   * to. Absent/empty = visible for every session (default). When set, the
   * panel and trigger defs only appear for sessions whose active mode id is
   * in this list; the service itself still runs daemon-wide.
   */
  modes?: string[];
}

export type PanelVariable = "PWD" | "SESSION_ID" | "HOME" | "USER" | "PROJECT_DIR";
