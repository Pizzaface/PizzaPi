import type {
  ServiceModeDef,
  ServicePanelPlacement,
  ServicePanelLauncherSurface,
  ServicePanelLauncherPosition,
  ServiceSigilDef,
  ServiceTriggerDef,
} from "@pizzapi/protocol";

export type {
  ServicePanelLauncherSurface,
  ServicePanelLauncherPosition,
} from "@pizzapi/protocol";

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
    /**
     * Declarative dock zone the host places this panel in by default — a
     * guaranteed placement such as "left-bottom". Omit to use the host default.
     */
    placement?: ServicePanelPlacement;
    /**
     * Open this panel automatically wherever it is visible (respecting `modes`)
     * instead of only on click, so a package-owned panel is present by default.
     */
    defaultOpen?: boolean;
    /**
     * Render this panel as a launcher on a dedicated surface instead of a docked
     * panel. When set the host shows a button at the configured position and
     * opens the panel iframe full-screen when clicked.
     */
    launcher?: {
      /** Surface the launcher button lives on. */
      surface: ServicePanelLauncherSurface;
      /** Horizontal position within that surface. */
      position: ServicePanelLauncherPosition;
    };
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
