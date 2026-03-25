/**
 * Service Panel Registry
 *
 * Maps runner service IDs to their UI panel components, labels, and icons.
 * Two sources of panels:
 *
 * 1. **Static panels** — hardcoded in SERVICE_PANELS below (e.g. Tunnel).
 *    These have custom React components compiled into the bundle.
 *
 * 2. **Dynamic panels** — announced by runner services at runtime via
 *    service_announce.panels[]. These render in a generic iframe that
 *    proxies to the service's HTTP server via the tunnel system.
 *
 * To add a new static panel:
 * 1. Create a React component (e.g. MyServicePanel.tsx)
 * 2. Add an entry to SERVICE_PANELS below
 *
 * To add a dynamic panel:
 * 1. Create a folder-based service in ~/.pizzapi/services/<name>/
 * 2. Include a manifest.json with label, icon, and panel config
 * 3. Start an HTTP server in init() and call announcePanel(port)
 */
import React from "react";
import { Network } from "lucide-react";
import { TunnelPanel } from "@/components/TunnelPanel";

export interface ServicePanelDef {
    /** Must match the runner service's `id` */
    serviceId: string;
    /** Button label in the header bar */
    label: string;
    /** Icon component (lucide) */
    icon: React.ReactNode;
    /** The panel component to render. Receives sessionId as a prop. */
    component: React.ComponentType<{ sessionId: string }>;
}

/**
 * Static service panels. Order determines button order in the header.
 * A panel only appears if the runner announces its serviceId.
 */
export const SERVICE_PANELS: ServicePanelDef[] = [
    {
        serviceId: "tunnel",
        label: "Tunnels",
        icon: <Network className="size-3.5" />,
        component: TunnelPanel,
    },
];
