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
import type { PanelPosition } from "@/hooks/usePanelLayout";

// ── Buttons for the header bar ────────────────────────────────────────────────

interface ServicePanelButtonsProps {
    availableServices: Set<string>;
    /** Dynamic panels announced by runner services at runtime. */
    dynamicPanels?: ServicePanelInfo[];
    activePanelIds: Set<string>;
    onTogglePanel: (serviceId: string) => void;
}

export function ServicePanelButtons({
    availableServices,
    dynamicPanels = [],
    activePanelIds,
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
                                activePanelIds.has(panel.serviceId) ? "bg-accent text-accent-foreground" : ""
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
                                activePanelIds.has(panel.serviceId) ? "bg-accent text-accent-foreground" : ""
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

const SERVICE_PANEL_POSITIONS_KEY = "pp-service-panel-positions";

function loadPanelPositions(): Map<string, PanelPosition> {
    try {
        const raw = localStorage.getItem(SERVICE_PANEL_POSITIONS_KEY);
        if (raw) return new Map(JSON.parse(raw) as [string, PanelPosition][]);
    } catch { /* ignore */ }
    return new Map();
}

function savePanelPositions(positions: Map<string, PanelPosition>) {
    try { localStorage.setItem(SERVICE_PANEL_POSITIONS_KEY, JSON.stringify([...positions])); } catch { /* ignore */ }
}

export function useServicePanelState() {
    const [activePanelIds, setActivePanelIds] = useState<Set<string>>(new Set());
    const [panelPositions, setPanelPositions] = useState<Map<string, PanelPosition>>(loadPanelPositions);
    // Ephemeral (non-persisted) position overrides used for auto-placement.
    // When a panel is opened next to an active panel, its position for this
    // session is stored here rather than in panelPositions / localStorage.
    // The override is cleared when the panel is closed.
    const [ephemeralPositions, setEphemeralPositions] = useState<Map<string, PanelPosition>>(new Map());

    const togglePanel = useCallback((serviceId: string) => {
        setActivePanelIds(prev => {
            const next = new Set(prev);
            if (next.has(serviceId)) {
                next.delete(serviceId);
            } else {
                next.add(serviceId);
            }
            return next;
        });
        // Clear ephemeral override when closing so that the next open uses the
        // stored preference (or a fresh auto-placement), not a stale transient.
        setEphemeralPositions(prev => {
            if (!prev.has(serviceId)) return prev;
            const next = new Map(prev);
            next.delete(serviceId);
            return next;
        });
    }, []);

    const closePanelById = useCallback((serviceId: string) => {
        setActivePanelIds(prev => {
            const next = new Set(prev);
            next.delete(serviceId);
            return next;
        });
        // Clear ephemeral override on explicit close as well.
        setEphemeralPositions(prev => {
            if (!prev.has(serviceId)) return prev;
            const next = new Map(prev);
            next.delete(serviceId);
            return next;
        });
    }, []);

    const closeAllPanels = useCallback(() => {
        setActivePanelIds(new Set());
        setEphemeralPositions(new Map());
    }, []);

    const getPanelPosition = useCallback((serviceId: string): PanelPosition => {
        // Ephemeral overrides take precedence over persisted positions so that
        // auto-placed panels render in the correct dock group for this session.
        return ephemeralPositions.get(serviceId) ?? panelPositions.get(serviceId) ?? "right";
    }, [ephemeralPositions, panelPositions]);

    const setPanelPosition = useCallback((serviceId: string, pos: PanelPosition) => {
        setPanelPositions(prev => {
            const next = new Map(prev);
            next.set(serviceId, pos);
            savePanelPositions(next);
            return next;
        });
        // A deliberate user action (drag/dock) clears any ephemeral override so
        // the newly-saved preference is used from this point forward.
        setEphemeralPositions(prev => {
            if (!prev.has(serviceId)) return prev;
            const next = new Map(prev);
            next.delete(serviceId);
            return next;
        });
    }, []);

    /** Set a transient position for this session only — does NOT persist to localStorage. */
    const setEphemeralPanelPosition = useCallback((serviceId: string, pos: PanelPosition) => {
        setEphemeralPositions(prev => {
            const next = new Map(prev);
            next.set(serviceId, pos);
            return next;
        });
    }, []);

    return { activePanelIds, togglePanel, closePanelById, closeAllPanels, getPanelPosition, setPanelPosition, setEphemeralPanelPosition };
}
