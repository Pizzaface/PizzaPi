/**
 * Dynamic service panel buttons and panel rendering.
 *
 * ServicePanelButtons — renders a button for each available service panel in the header.
 * ServicePanelContainer — renders the active service panel below the session viewer.
 */
import React, { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { SERVICE_PANELS, type ServicePanelDef } from "./registry";

// ── Buttons for the header bar ────────────────────────────────────────────────

interface ServicePanelButtonsProps {
    availableServices: Set<string>;
    activePanelId: string | null;
    onTogglePanel: (serviceId: string) => void;
}

export function ServicePanelButtons({
    availableServices,
    activePanelId,
    onTogglePanel,
}: ServicePanelButtonsProps) {
    const visiblePanels = SERVICE_PANELS.filter(p => availableServices.has(p.serviceId));

    if (visiblePanels.length === 0) return null;

    return (
        <>
            {visiblePanels.map(panel => (
                <Button
                    key={panel.serviceId}
                    className={`h-7 w-7 sm:h-7 sm:w-auto sm:px-2.5 sm:text-[0.7rem] ${
                        activePanelId === panel.serviceId ? "bg-accent text-accent-foreground" : ""
                    }`}
                    onClick={() => onTogglePanel(panel.serviceId)}
                    size="icon"
                    type="button"
                    variant="outline"
                    title={`Toggle ${panel.label}`}
                    aria-label={`Toggle ${panel.label}`}
                >
                    {panel.icon}
                    <span className="hidden sm:inline ml-1">{panel.label}</span>
                </Button>
            ))}
        </>
    );
}

// ── Panel container (renders the active panel) ───────────────────────────────

interface ServicePanelContainerProps {
    activePanelId: string | null;
    sessionId: string;
    onClose: () => void;
    position?: "bottom" | "right";
}

export function ServicePanelContainer({
    activePanelId,
    sessionId,
    onClose,
    position = "bottom",
}: ServicePanelContainerProps) {
    if (!activePanelId) return null;

    const panelDef = SERVICE_PANELS.find(p => p.serviceId === activePanelId);
    if (!panelDef) return null;

    const PanelComponent = panelDef.component;

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
                    {panelDef.icon}
                    {panelDef.label}
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={onClose}
                    aria-label={`Close ${panelDef.label}`}
                >
                    <X className="size-3" />
                </Button>
            </div>

            {/* Panel content */}
            <div className="flex-1 overflow-hidden">
                <PanelComponent sessionId={sessionId} />
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
