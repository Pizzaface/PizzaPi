/**
 * Dynamic service panel buttons and panel rendering.
 *
 * ServicePanelButtons — renders a button for each available service panel in the header.
 * ServicePanelContainer — renders the active service panel below the session viewer.
 */
import React, { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { X } from "lucide-react";
import { SERVICE_PANELS, type ServicePanelDef } from "./registry";
import { DynamicLucideIcon } from "./lucide-icon";
import { IframeServicePanel } from "./IframeServicePanel";
import type { ServicePanelInfo } from "@pizzapi/protocol";

// ── Buttons for the header bar ────────────────────────────────────────────────

interface ServicePanelButtonsProps {
    availableServices: Set<string>;
    /** Dynamic panels announced by runner services at runtime. */
    dynamicPanels?: ServicePanelInfo[];
    activePanelId: string | null;
    onTogglePanel: (serviceId: string) => void;
}

export function ServicePanelButtons({
    availableServices,
    dynamicPanels = [],
    activePanelId,
    onTogglePanel,
}: ServicePanelButtonsProps) {
    // Static panels from the compiled registry
    const visibleStaticPanels = SERVICE_PANELS.filter(p => availableServices.has(p.serviceId));
    // Dynamic panels — exclude any that have a static panel (static wins)
    const staticIds = new Set(SERVICE_PANELS.map(p => p.serviceId));
    const visibleDynamicPanels = dynamicPanels.filter(p => !staticIds.has(p.serviceId));

    if (visibleStaticPanels.length === 0 && visibleDynamicPanels.length === 0) return null;

    return (
        <>
            {visibleStaticPanels.map(panel => (
                <Tooltip key={panel.serviceId}>
                    <TooltipTrigger asChild>
                        <Button
                            className={`h-7 w-7 ${
                                activePanelId === panel.serviceId ? "bg-accent text-accent-foreground" : ""
                            }`}
                            onClick={() => onTogglePanel(panel.serviceId)}
                            size="icon"
                            type="button"
                            variant="outline"
                            aria-label={`Toggle ${panel.label}`}
                        >
                            {panel.icon}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{panel.label}</TooltipContent>
                </Tooltip>
            ))}
            {visibleDynamicPanels.map(panel => (
                <Tooltip key={panel.serviceId}>
                    <TooltipTrigger asChild>
                        <Button
                            className={`h-7 w-7 ${
                                activePanelId === panel.serviceId ? "bg-accent text-accent-foreground" : ""
                            }`}
                            onClick={() => onTogglePanel(panel.serviceId)}
                            size="icon"
                            type="button"
                            variant="outline"
                            aria-label={`Toggle ${panel.label}`}
                        >
                            <DynamicLucideIcon name={panel.icon} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{panel.label}</TooltipContent>
                </Tooltip>
            ))}
        </>
    );
}

// ── Panel container (renders the active panel) ───────────────────────────────

interface ServicePanelContainerProps {
    activePanelId: string | null;
    sessionId: string;
    /** Dynamic panels from service_announce. */
    dynamicPanels?: ServicePanelInfo[];
    onClose: () => void;
    position?: "bottom" | "right";
}

export function ServicePanelContainer({
    activePanelId,
    sessionId,
    dynamicPanels = [],
    onClose,
    position = "bottom",
}: ServicePanelContainerProps) {
    if (!activePanelId) return null;

    // Try static registry first, then dynamic panels
    const staticDef = SERVICE_PANELS.find(p => p.serviceId === activePanelId);
    const dynamicDef = !staticDef ? dynamicPanels.find(p => p.serviceId === activePanelId) : null;

    if (!staticDef && !dynamicDef) return null;

    const label = staticDef?.label ?? dynamicDef!.label;
    const icon = staticDef?.icon ?? <DynamicLucideIcon name={dynamicDef!.icon} />;

    return (
        <div
            className={`border-border bg-background flex flex-col ${
                position === "bottom"
                    ? "border-t w-full"
                    : "border-l h-full"
            }`}
            style={position === "bottom" ? { height: "280px" } : { width: "320px" }}
        >
            {/* Panel header */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30 shrink-0">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                    {icon}
                    {label}
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={onClose}
                    aria-label={`Close ${label}`}
                >
                    <X className="size-3" />
                </Button>
            </div>

            {/* Panel content */}
            <div className="flex-1 overflow-hidden">
                {staticDef ? (
                    <staticDef.component sessionId={sessionId} />
                ) : (
                    <IframeServicePanel sessionId={sessionId} port={dynamicDef!.port} />
                )}
            </div>
        </div>
    );
}

// ── Hook for managing service panel state ─────────────────────────────────────

export function useServicePanelState() {
    const [activePanelId, setActivePanelId] = useState<string | null>(null);

    const togglePanel = useCallback((serviceId: string) => {
        setActivePanelId(prev => prev === serviceId ? null : serviceId);
    }, []);

    const closePanel = useCallback(() => {
        setActivePanelId(null);
    }, []);

    return { activePanelId, togglePanel, closePanel };
}
