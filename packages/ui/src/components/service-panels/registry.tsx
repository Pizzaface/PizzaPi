/**
 * Service Panel Registry
 *
 * Maps runner service IDs to their UI panel components, labels, and icons.
 * When the runner announces a service and this registry has a panel for it,
 * the UI renders a toggleable panel button in the session header.
 *
 * To add a new service panel:
 * 1. Create a React component (e.g. MyServicePanel.tsx)
 * 2. Add an entry to SERVICE_PANELS below
 */
import React from "react";
import { Activity, Network } from "lucide-react";
import { SystemMonitorPanel } from "@/components/SystemMonitorPanel";
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
 * All known service panels. Order determines button order in the header.
 * A panel only appears if the runner announces its serviceId.
 */
export const SERVICE_PANELS: ServicePanelDef[] = [
    {
        serviceId: "tunnel",
        label: "Tunnels",
        icon: <Network className="size-3.5" />,
        component: TunnelPanel,
    },
    {
        serviceId: "system-monitor",
        label: "System",
        icon: <Activity className="size-3.5" />,
        component: SystemMonitorPanel as React.ComponentType<{ sessionId: string }>,
    },
];
