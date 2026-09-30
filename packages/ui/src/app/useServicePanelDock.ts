import * as React from "react";
import type { Socket } from "socket.io-client";
import type { ServicePanelInfo, ViewerServerToClientEvents, ViewerClientToServerEvents } from "@pizzapi/protocol";
import type { CombinedPanelTab } from "@/components/CombinedPanel";
import type { PanelPosition } from "@/hooks/usePanelLayout";
import type { useButtonPosition } from "@/hooks/useButtonPosition";
import type { useRunnersFeed } from "@/lib/useRunnersFeed";
import type { SessionLifecycleRefs } from "@/lib/use-session-lifecycle";
import { useServicePanelState, useVisibleServicePanels } from "@/components/service-panels/ServicePanels";
import { SERVICE_PANELS } from "@/components/service-panels/registry";
import { parsePanelId, scopePanelIdToRunner } from "@/components/service-panels/panel-instance";
import { resolveNewPanelPosition, resolvePanelToggleAction, computeAutoOpenPanels } from "@/utils/servicePanelUtils";
import { matchesViewerGeneration, matchesViewerSession } from "@/lib/viewer-switch";
import { resolveDeclaredPanelPlacements } from "./panel-zones";

type FeedRunner = ReturnType<typeof useRunnersFeed>["runners"][number];

export interface ServicePanelDockOptions {
  viewerSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null;
  lifecycleRefs: SessionLifecycleRefs;
  activeSessionInfo: { runnerId: string | null; cwd: string } | null;
  feedRunners: FeedRunner[];
  dynamicPanels: ServicePanelInfo[];
  modePanels: ServicePanelInfo[];
  modeVisibleServices: Set<string>;
  disabledServiceIds: Set<string>;
  combinedActiveTab: string;
  handleCombinedTabChange: (id: string) => void;
  buttonPositions: ReturnType<typeof useButtonPosition>;
}

/**
 * Runner service panels in the dock: open/close/position state, closing
 * panels whose service disappeared (or whose pinned runner went offline),
 * package-declared placement and auto-open, tunnel auto-open on registration,
 * and the rail/strip button wiring.
 */
export function useServicePanelDock(options: ServicePanelDockOptions) {
  const {
    viewerSocket,
    lifecycleRefs,
    activeSessionInfo,
    feedRunners,
    dynamicPanels,
    modePanels,
    modeVisibleServices,
    disabledServiceIds,
    combinedActiveTab,
    handleCombinedTabChange,
    buttonPositions,
  } = options;

  // Package-declared "guaranteed placement" for dynamic panels
  // (ServicePanelInfo.placement). Maps serviceId → dock zone so a package-owned
  // panel lands where its package asked (e.g. left-bottom) instead of the
  // generic default, unless the user has since moved it. Launcher panels are
  // excluded because they render on their dedicated surface.
  const declaredPanelPlacements = React.useMemo(
    () => resolveDeclaredPanelPlacements(dynamicPanels),
    [dynamicPanels],
  );
  const resolveDeclaredPanelPlacement = React.useCallback(
    (serviceId: string) => declaredPanelPlacements.get(serviceId),
    [declaredPanelPlacements],
  );

  const { activePanelIds: activeServicePanels, togglePanel: toggleServicePanel, closePanelById: closeServicePanelById, getPanelPosition: getServicePanelPosition, setPanelPosition: setServicePanelPosition, setEphemeralPanelPosition: setEphemeralServicePanelPosition, getNavParams: getServicePanelNavParams } = useServicePanelState(resolveDeclaredPanelPlacement);

  // Always-current ref so the runner-change effect below can read the active
  // panel set without listing it as a dependency (avoids a close→reopen loop).
  const activeServicePanelsRef = React.useRef(activeServicePanels);
  activeServicePanelsRef.current = activeServicePanels;

  // When the runner's service list changes (session switch, reconnect, etc.),
  // close any panels whose service is no longer available in this runner.
  // Launcher panels are excluded — they live in a dedicated full-screen surface
  // and are not tracked by useServicePanelState.
  React.useEffect(() => {
    const current = activeServicePanelsRef.current;
    if (current.size === 0) return;
    const staticAvailable = new Set(
      SERVICE_PANELS.filter(p => modeVisibleServices.has(p.serviceId)).map(p => p.serviceId),
    );
    const dynamicAvailable = new Set(modePanels.filter((p) => !p.launcher).map(p => p.serviceId));
    for (const id of current) {
      // Runner-scoped tunnel tabs are governed by their pinned runner, not by
      // whichever runner happens to be active in the viewer.
      if (parsePanelId(id).runnerId) continue;
      if (!staticAvailable.has(id) && !dynamicAvailable.has(id)) {
        closeServicePanelById(id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeVisibleServices, modePanels, closeServicePanelById]);

  // A traveling panel remains available while its own runner is connected,
  // even when the active session belongs to another runner.
  React.useEffect(() => {
    for (const id of activeServicePanels) {
      const { runnerId } = parsePanelId(id);
      if (runnerId && !feedRunners.some((runner) => runner.runnerId === runnerId)) {
        closeServicePanelById(id);
      }
    }
  }, [activeServicePanels, feedRunners, closeServicePanelById]);

  // Auto-open package panels that ask for it (ServicePanelInfo.defaultOpen) when
  // they become visible in the active mode, so a package-owned, mode-scoped
  // panel is present without a click. Track which we auto-opened so a user
  // closing one doesn't fight a reopen; forget a panel once it leaves the mode
  // so re-entering the mode opens it again. The cleanup effect above closes
  // panels that leave modePanels. Launcher panels are excluded — they open via
  // their dedicated surface, not the dock.
  const autoOpenedPanelsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const { toOpen, nextTracked } = computeAutoOpenPanels(
      modePanels.filter((p) => !p.launcher),
      autoOpenedPanelsRef.current,
      (id) => activeServicePanelsRef.current.has(id),
    );
    autoOpenedPanelsRef.current = nextTracked;
    for (const id of toOpen) toggleServicePanel(id);
  }, [modePanels, toggleServicePanel]);

  // Auto-open Tunnel panel when a non-pinned tunnel is registered.
  React.useEffect(() => {
    if (!viewerSocket) return;
    const handler = (envelope: { serviceId: string; type: string; sessionId?: string; runnerId?: string; generation?: number; payload: unknown }) => {
      if (envelope.serviceId !== "tunnel" || envelope.type !== "tunnel_registered") return;
      // Follow-room runner-level announcements can coexist on the same socket
      // with the active session's events; never let one auto-open a tab for a
      // runner the viewer is not currently looking at.
      if (envelope.runnerId && envelope.runnerId !== activeSessionInfo?.runnerId) return;
      if (
        !matchesViewerSession(lifecycleRefs.activeSessionId.current, envelope.sessionId) ||
        !matchesViewerGeneration(lifecycleRefs.generation.current, envelope.generation)
      ) return;
      const info = envelope.payload as { pinned?: boolean } | undefined;
      if (info?.pinned) return; // Don't auto-open for daemon-pinned panel ports
      const targetRunnerId = envelope.runnerId ?? activeSessionInfo?.runnerId;
      // Open the Tunnel panel if not already open
      if (!activeServicePanels.has(scopePanelIdToRunner("tunnel", targetRunnerId))) {
        toggleServicePanel(scopePanelIdToRunner("tunnel", targetRunnerId));
      }
    };
    viewerSocket.on("service_message", handler);
    return () => { viewerSocket.off("service_message", handler); };
  }, [viewerSocket, activeServicePanels, activeSessionInfo?.runnerId, toggleServicePanel]);

  // Always-current ref to the computed panel groups (defined below) so the
  // toggle handler can check zone contents without a dependency cycle.
  const panelGroupsRef = React.useRef<Record<PanelPosition, CombinedPanelTab[]> | null>(null);

  const handleToggleServicePanel = React.useCallback((serviceId: string, query?: string, fragment?: string, positionOverride?: PanelPosition) => {
    // Tunnel panels are pinned to the runner active when they are opened;
    // other service panels retain their historical unscoped ids.
    const panelId = serviceId === "tunnel"
      ? scopePanelIdToRunner(serviceId, activeSessionInfo?.runnerId)
      : serviceId;
    // When called with nav params on an already-open panel, update params
    // and re-navigate rather than closing.
    const hasNavParams = !!(query || fragment);
    if (activeServicePanels.has(panelId) && !hasNavParams) {
      // Only close when the panel is the tab actually shown in its dock zone.
      // If another tab is on top of the same zone, bring this panel forward
      // instead of closing it.
      const zoneTabs = panelGroupsRef.current?.[getServicePanelPosition(panelId)] ?? [];
      const action = resolvePanelToggleAction(zoneTabs.map(t => t.id), combinedActiveTab, panelId);
      if (action === "close") {
        closeServicePanelById(panelId);
      } else {
        handleCombinedTabChange(panelId);
      }
    } else {
      if (!activeServicePanels.has(panelId) && positionOverride) {
        // Opened from a docked button — the button's dock zone wins over
        // auto-placement so the panel opens on the side the icon is on.
        setServicePanelPosition(panelId, positionOverride);
      } else if (!activeServicePanels.has(panelId)) {
        const newPosition = resolveNewPanelPosition(
          panelId,
          combinedActiveTab,
          activeServicePanels,
          getServicePanelPosition,
        );
        if (activeServicePanels.has(combinedActiveTab)) {
          setEphemeralServicePanelPosition(panelId, newPosition);
        }
      }
      toggleServicePanel(panelId, query, fragment);
      handleCombinedTabChange(panelId);
    }
  }, [activeServicePanels, activeSessionInfo?.runnerId, closeServicePanelById, toggleServicePanel, handleCombinedTabChange, combinedActiveTab, setEphemeralServicePanelPosition, getServicePanelPosition, setServicePanelPosition]);

  // ── Service panel buttons in rails/strips ────────────────────────────
  const visibleServicePanels = useVisibleServicePanels(modeVisibleServices, modePanels, disabledServiceIds);
  const isActiveServicePanel = React.useCallback((serviceId: string) => {
    if (serviceId !== "tunnel") return activeServicePanels.has(serviceId);
    return activeServicePanels.has(scopePanelIdToRunner("tunnel", activeSessionInfo?.runnerId));
  }, [activeServicePanels, activeSessionInfo?.runnerId]);

  const railServicePanels = React.useMemo(
    () => visibleServicePanels.map((p) => ({ ...p, active: isActiveServicePanel(p.serviceId) })),
    [visibleServicePanels, isActiveServicePanel],
  );
  const servicePanelButtonActiveIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const id of activeServicePanels) {
      const parsed = parsePanelId(id);
      if (parsed.serviceId === "tunnel") {
        if (parsed.runnerId === activeSessionInfo?.runnerId) ids.add("tunnel");
      } else if (!parsed.runnerId) {
        ids.add(id);
      }
    }
    return ids;
  }, [activeServicePanels, activeSessionInfo?.runnerId]);

  const handleToggleServicePanelFromDock = React.useCallback((serviceId: string) => {
    const slot = buttonPositions.positions[`service:${serviceId}`];
    const override = !isActiveServicePanel(serviceId) && slot && slot !== "top" ? slot : undefined;
    handleToggleServicePanel(serviceId, undefined, undefined, override);
  }, [buttonPositions.positions, isActiveServicePanel, handleToggleServicePanel]);

  return {
    activeServicePanels,
    toggleServicePanel,
    closeServicePanelById,
    getServicePanelPosition,
    setServicePanelPosition,
    getServicePanelNavParams,
    panelGroupsRef,
    handleToggleServicePanel,
    railServicePanels,
    servicePanelButtonActiveIds,
    handleToggleServicePanelFromDock,
  };
}
