import * as React from "react";
import { Suspense } from "react";
import type { Socket } from "socket.io-client";
import type { ServicePanelInfo, ViewerServerToClientEvents, ViewerClientToServerEvents } from "@pizzapi/protocol";
import { TerminalIcon, FolderTree, GitBranch, Zap, BarChart3, FileText } from "lucide-react";
import type { HubSession } from "@/components/SessionSidebar";
import { ArtifactViewerContent } from "@/components/session-viewer/ArtifactCard";
import type { CombinedPanelTab } from "@/components/CombinedPanel";
import type { PizzaPiNavActions } from "@/components/sigils/PizzaPiNavContext";
import { resolveFilePath } from "@/components/file-explorer/utils";
import { SERVICE_PANELS } from "@/components/service-panels/registry";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { parsePanelId } from "@/components/service-panels/panel-instance";
import { runnerDisplayName, runnerHue } from "@/components/service-panels/runner-scope";
import { IframeServicePanel } from "@/components/service-panels/IframeServicePanel";
import { resolveActiveTabIdFromIds } from "@/utils/servicePanelUtils";
import { shouldCenterTopSpanFullWidth, shouldCenterBottomSpanFullWidth } from "@/utils/panelLayoutHelpers";
import type { usePanelLayout, PanelPosition } from "@/hooks/usePanelLayout";
import type { useButtonPosition, ToolbarButtonId } from "@/hooks/useButtonPosition";
import { resolvePanelToggleAction } from "@/utils/servicePanelUtils";
import type { useTriggerCount } from "@/hooks/useTriggerCount";
import type { useRunnersFeed } from "@/lib/useRunnersFeed";
import type { SessionUiCacheEntry } from "@/lib/types";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import type { resolveModeUi } from "@pizzapi/protocol";
import {
  LazyEventsRoutesPanel,
  LazyFileExplorer,
  LazyGitPanel,
  LazySessionAnalyzerBody,
  LazyTerminalManager,
  PanelFallback,
} from "./lazy-surfaces";
import type { AuxPanels } from "./useAuxPanels";
import type { useServicePanelDock } from "./useServicePanelDock";
import type { StateSetter } from "./types";
import { buildColumnZones, createEmptyPanelGroups, getPanelGroupKey as panelGroupKey } from "./panel-zones";

type FeedRunner = ReturnType<typeof useRunnersFeed>["runners"][number];

export interface DockPanelsOptions {
  panelLayout: ReturnType<typeof usePanelLayout>;
  auxPanels: AuxPanels;
  serviceDock: ReturnType<typeof useServicePanelDock>;
  activeSessionId: string | null;
  activeSessionInfo: { runnerId: string | null; cwd: string } | null;
  liveSessions: HubSession[];
  feedRunners: FeedRunner[];
  runnersStatus: ReturnType<typeof useRunnersFeed>["status"];
  viewerSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null;
  dynamicPanels: ServicePanelInfo[];
  modeUi: ReturnType<typeof resolveModeUi>;
  analysis: SessionUiCacheEntry["analysis"];
  triggerCounts: ReturnType<typeof useTriggerCount>;
  handleOpenSession: (id: string) => void;
  setLifecycleSpawnParams: UseSessionLifecycleResult["setSpawnParams"];
  setNewSessionOpen: StateSetter<boolean>;
  setSelectedRunnerId: StateSetter<string | null>;
  setRunnerManagerInitialTab: StateSetter<"sessions" | "triggers">;
  setShowRunners: StateSetter<boolean>;
  buttonPositions: ReturnType<typeof useButtonPosition>;
}

/**
 * Builds every docked panel tab (terminal, files, git, triggers, analyzer,
 * artifact viewer, runner service panels), groups them by dock zone, derives
 * the side-column / center zone layout, and owns per-group collapse state.
 * Also exposes the file-sigil → file-explorer navigation and the
 * PizzaPiNavProvider actions.
 */
export function useDockPanels(options: DockPanelsOptions) {
  const {
    panelLayout: {
      showTerminal, setShowTerminal,
      terminalPosition,
      handleTerminalPositionChange,
      startPanelDragWith,
      combinedActiveTab, handleCombinedTabChange,
      terminalTabs, activeTerminalId, setActiveTerminalId,
      handleTerminalTabAdd, handleTerminalTabClose,
      showFileExplorer, setShowFileExplorer,
      filesPosition,
      handleFilesPositionChange,
      showGit, setShowGit,
      gitPosition, handleGitPositionChange,
      leftTopHeight, leftBottomHeight,
      rightTopHeight, rightBottomHeight,
      showTriggers, setShowTriggers,
      triggersPosition, handleTriggersPositionChange,
    },
    auxPanels: {
      showAnalyzer, setShowAnalyzer, analyzerPosition, handleAnalyzerPositionChange,
      artifactViewer, setArtifactViewer, artifactViewerPosition, handleArtifactViewerPositionChange,
    },
    serviceDock: {
      activeServicePanels,
      closeServicePanelById,
      getServicePanelPosition,
      setServicePanelPosition,
      getServicePanelNavParams,
      panelGroupsRef,
      handleToggleServicePanel,
    },
    activeSessionId,
    activeSessionInfo,
    liveSessions,
    feedRunners,
    runnersStatus,
    viewerSocket,
    dynamicPanels,
    modeUi,
    analysis,
    triggerCounts,
    handleOpenSession,
    setLifecycleSpawnParams,
    setNewSessionOpen,
    setSelectedRunnerId,
    setRunnerManagerInitialTab,
    setShowRunners,
    buttonPositions,
  } = options;

  const openPanelFromDockedButton = React.useCallback(
    (buttonId: ToolbarButtonId, isOpen: boolean, setOpen: (updater: (v: boolean) => boolean) => void, setPosition: (pos: PanelPosition) => void) => {
      if (isOpen) {
        // Already open: close only if this panel is the tab shown on top of its
        // zone. If another tab is on top, bring this one forward instead of
        // closing it (mirrors the service-panel toggle behavior).
        const groups = panelGroupsRef.current;
        const zone = groups && (Object.keys(groups) as PanelPosition[]).find(
          (pos) => groups[pos].some((t) => t.id === buttonId),
        );
        const zoneTabIds = zone ? groups![zone].map((t) => t.id) : [buttonId];
        if (resolvePanelToggleAction(zoneTabIds, combinedActiveTab, buttonId) === "focus") {
          handleCombinedTabChange(buttonId);
          return;
        }
        setOpen(() => false);
        return;
      }
      // Opening: dock near the button if it lives in a rail/strip, then focus it.
      const slot = buttonPositions.positions[buttonId];
      if (slot !== "top") setPosition(slot);
      setOpen(() => true);
      handleCombinedTabChange(buttonId);
    },
    [buttonPositions.positions, combinedActiveTab, handleCombinedTabChange],
  );

  // Stable session ID for tunnel URLs — stays constant across same-runner
  // session switches so iframe service panels don't reload. The tunnel proxy
  // resolves sessionId → runnerId anyway, so any valid session on the same
  // runner routes to the same localhost ports.
  //
  // If the cached session goes offline (ended/removed), we fall back to the
  // current activeSessionId and update the cache.
  const tunnelSessionMapRef = React.useRef<Map<string, string>>(new Map());
  const tunnelSessionId = React.useMemo(() => {
    if (!activeSessionId || !activeSessionInfo?.runnerId) return activeSessionId;
    const runnerId = activeSessionInfo.runnerId;
    const cached = tunnelSessionMapRef.current.get(runnerId);
    if (cached) {
      // Verify the cached session is still live — if it was ended, the
      // tunnel proxy would 404. Fall through to adopt the current session.
      if (liveSessions.some((s) => s.sessionId === cached && s.runnerId === runnerId)) return cached;
    }
    tunnelSessionMapRef.current.set(runnerId, activeSessionId);
    return activeSessionId;
  }, [activeSessionId, activeSessionInfo?.runnerId, liveSessions]);

  // Runner-scoped tunnel panels keep their own service-session identity while
  // the viewer moves between runners. HTTP itself uses runnerId, but tunnel
  // service commands still need a live session to own/list session tunnels.
  const resolveTunnelSessionForRunner = React.useCallback((runnerId: string): string | undefined => {
    const cached = tunnelSessionMapRef.current.get(runnerId);
    if (cached && liveSessions.some((s) => s.sessionId === cached && s.runnerId === runnerId)) return cached;
    const live = liveSessions.find((s) => s.runnerId === runnerId);
    if (live) {
      tunnelSessionMapRef.current.set(runnerId, live.sessionId);
      return live.sessionId;
    }
    return undefined;
  }, [liveSessions]);

  // File sigils → open the file in the file explorer panel.
  const [fileToOpen, setFileToOpen] = React.useState<{ path: string } | null>(null);
  const handleOpenFileInExplorer = React.useCallback((path: string) => {
    const cwd = activeSessionInfo?.cwd;
    if (!cwd || !activeSessionInfo?.runnerId) return;
    const abs = resolveFilePath(cwd, path);
    setFileToOpen({ path: abs });
    setShowFileExplorer(true);
    handleCombinedTabChange("files");
  }, [activeSessionInfo?.cwd, activeSessionInfo?.runnerId, setShowFileExplorer, handleCombinedTabChange]);

  const pizzaPiNavActions = React.useMemo<PizzaPiNavActions>(() => ({
    toggleServicePanel: handleToggleServicePanel,
    setActiveSessionId: (sessionId: string) => handleOpenSession(sessionId),
    openFile: handleOpenFileInExplorer,
  }), [handleToggleServicePanel, handleOpenSession, handleOpenFileInExplorer]);

  const terminalPanelTab = React.useMemo<CombinedPanelTab | null>(() => showTerminal ? {
    id: "terminal",
    label: "Terminal",
    icon: <TerminalIcon className="size-3.5" />,
    onClose: () => setShowTerminal(false),
    onDragStart: (e) => startPanelDragWith(e, handleTerminalPositionChange),
    keepMountedWhenInactive: true,
    content: (
      <Suspense fallback={<PanelFallback label="Terminal" />}>
        <LazyTerminalManager
          className="h-full"
          embedded
          sessionId={activeSessionId}
          runnerId={activeSessionInfo?.runnerId ?? undefined}
          defaultCwd={activeSessionInfo?.cwd || undefined}
          runners={feedRunners.map(r => ({
            runnerId: r.runnerId,
            name: r.name,
            roots: r.roots,
            sessionCount: liveSessions.filter(s => s.runnerId === r.runnerId).length,
          }))}
          runnersLoading={runnersStatus === "connecting"}
          tabs={terminalTabs}
          activeTabId={activeTerminalId}
          onActiveTabChange={setActiveTerminalId}
          onTabAdd={handleTerminalTabAdd}
          onTabClose={handleTerminalTabClose}
        />
      </Suspense>
    ),
  } : null, [showTerminal, activeSessionId, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, feedRunners, liveSessions, runnersStatus, terminalTabs, activeTerminalId, setActiveTerminalId, handleTerminalTabAdd, handleTerminalTabClose, startPanelDragWith, handleTerminalPositionChange]);

  const filesPanelTab = React.useMemo<CombinedPanelTab | null>(() => (showFileExplorer && activeSessionInfo?.runnerId && activeSessionInfo?.cwd) ? {
    id: "files",
    label: "Files",
    icon: <FolderTree className="size-3.5" />,
    onClose: () => setShowFileExplorer(false),
    onDragStart: (e) => startPanelDragWith(e, handleFilesPositionChange),
    content: (
      <Suspense fallback={<PanelFallback label="Files" />}>
        <LazyFileExplorer
          runnerId={activeSessionInfo.runnerId}
          cwd={activeSessionInfo.cwd}
          className="h-full"
          openFile={fileToOpen}
        />
      </Suspense>
    ),
  } : null, [showFileExplorer, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, startPanelDragWith, handleFilesPositionChange, fileToOpen]);

  // Open a git worktree as its own session: prefill the New Session wizard with
  // the worktree path as cwd (same flow as duplicating a session).
  const handleOpenWorktree = React.useCallback((worktreePath: string) => {
    const runnerId = activeSessionInfo?.runnerId;
    if (!runnerId || !worktreePath) return;
    setLifecycleSpawnParams({ runnerId, preselectedRunnerId: runnerId, cwd: worktreePath });
    setNewSessionOpen(true);
  }, [activeSessionInfo?.runnerId, setLifecycleSpawnParams]);

  const gitPanelTab = React.useMemo<CombinedPanelTab | null>(() => (showGit && activeSessionInfo?.runnerId && activeSessionInfo?.cwd) ? {
    id: "git",
    label: "Git",
    icon: <GitBranch className="size-3.5" />,
    onClose: () => setShowGit(false),
    onDragStart: (e) => startPanelDragWith(e, handleGitPositionChange),
    content: (
      <Suspense fallback={<PanelFallback label="Git" />}>
        <LazyGitPanel
          cwd={activeSessionInfo.cwd}
          onOpenWorktree={handleOpenWorktree}
        />
      </Suspense>
    ),
  } : null, [showGit, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, startPanelDragWith, handleGitPositionChange, handleOpenWorktree]);

  const triggersPanelTab = React.useMemo<CombinedPanelTab | null>(() => (showTriggers && activeSessionId) ? {
    id: "triggers",
    label: "Triggers",
    icon: <Zap className="size-3.5" />,
    onClose: () => setShowTriggers(false),
    onDragStart: (e) => startPanelDragWith(e, handleTriggersPositionChange),
    content: (
      <Suspense fallback={<PanelFallback label="Triggers" />}>
        <LazyEventsRoutesPanel
          sessionId={activeSessionId}
          viewerSocket={viewerSocket}
          onBadgeRefresh={triggerCounts.refresh}
          onOpenManager={() => {
            if (activeSessionInfo?.runnerId) setSelectedRunnerId(activeSessionInfo.runnerId);
            setRunnerManagerInitialTab("triggers");
            setShowRunners(true);
          }}
        />
      </Suspense>
    ),
  } : null, [showTriggers, activeSessionId, activeSessionInfo?.runnerId, viewerSocket, triggerCounts.refresh, startPanelDragWith, handleTriggersPositionChange, setShowTriggers]);

  const analyzerPanelTab = React.useMemo<CombinedPanelTab | null>(() => {
    if (!showAnalyzer || !activeSessionId) return null;
    return {
      id: "analyzer",
      label: "Context & Cache Analysis",
      icon: <BarChart3 className="size-3.5" />,
      onClose: () => setShowAnalyzer(false),
      onDragStart: (e) => startPanelDragWith(e, handleAnalyzerPositionChange),
      content: (
        <Suspense fallback={<PanelFallback label="Analysis" />}>
          <LazySessionAnalyzerBody
            analysis={analysis}
            runnerId={activeSessionInfo?.runnerId ?? null}
            sessionId={activeSessionId}
          />
        </Suspense>
      ),
    };
  }, [showAnalyzer, activeSessionId, activeSessionInfo?.runnerId, analysis, startPanelDragWith, handleAnalyzerPositionChange]);

  const artifactViewerPanelTab = React.useMemo<CombinedPanelTab | null>(() => {
    if (!artifactViewer || !activeSessionId) return null;
    const fileName = artifactViewer.path.split(/[\\/]/).filter(Boolean).pop() ?? artifactViewer.path;
    return {
      id: "artifact-viewer",
      label: artifactViewer.title ?? fileName,
      icon: <FileText className="size-3.5" />,
      onClose: () => setArtifactViewer(null),
      onDragStart: (e) => startPanelDragWith(e, handleArtifactViewerPositionChange),
      content: (
        <ArtifactViewerContent
          path={artifactViewer.path}
          kind={artifactViewer.kind}
          title={artifactViewer.title}
          runnerId={activeSessionInfo?.runnerId ?? undefined}
          onOpen={modeUi.files ? handleOpenFileInExplorer : undefined}
        />
      ),
    };
  }, [artifactViewer, activeSessionId, activeSessionInfo?.runnerId, modeUi.files, handleOpenFileInExplorer, startPanelDragWith, handleArtifactViewerPositionChange]);

  const servicePanelTabs = React.useMemo<CombinedPanelTab[]>(() => {
    // Scoped tunnel panels keep their own runner/session identity. Other
    // panels retain the active-session behavior they have always had.
    const effectiveSessionId = tunnelSessionId ?? activeSessionId;
    if (activeServicePanels.size === 0) return [];

    const tabs: CombinedPanelTab[] = [];
    for (const panelId of activeServicePanels) {
      const { serviceId, instance, runnerId: scopedRunnerId } = parsePanelId(panelId);
      const staticDef = SERVICE_PANELS.find(p => p.serviceId === serviceId);
      const dynamicDef = !staticDef ? dynamicPanels.find(p => p.serviceId === serviceId) : null;
      if (!staticDef && !dynamicDef) continue;

      const panelRunnerId = scopedRunnerId ?? activeSessionInfo?.runnerId ?? undefined;
      const panelSessionId = scopedRunnerId
        ? resolveTunnelSessionForRunner(scopedRunnerId)
        : effectiveSessionId;
      // A runner-scoped tunnel can still render its runner URL without a live
      // session; other panels require the active session as before.
      if (!panelSessionId && !scopedRunnerId) continue;

      const baseLabel = staticDef?.label ?? dynamicDef!.label;
      const runnerLabel = scopedRunnerId ? runnerDisplayName(scopedRunnerId, feedRunners) : undefined;
      const label = scopedRunnerId
        ? `${baseLabel}${instance ? ` ${instance}` : ""} · ${runnerLabel}`
        : instance ? `${baseLabel} ${instance}` : baseLabel;
      const baseIcon = staticDef?.icon ?? <DynamicLucideIcon name={dynamicDef!.icon} />;
      const icon = scopedRunnerId ? (
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: `hsl(${runnerHue(scopedRunnerId)} 70% 50%)` }} />
          {baseIcon}
        </span>
      ) : baseIcon;
      const navParams = getServicePanelNavParams(panelId);
      const content = staticDef
        ? <staticDef.component
            sessionId={panelSessionId ?? ""}
            runnerId={panelRunnerId}
            panelId={panelId}
            onSpawnPanel={handleToggleServicePanel}
            runnerName={runnerLabel}
            runnerOnline={scopedRunnerId ? feedRunners.some((runner) => runner.runnerId === scopedRunnerId) : undefined}
          />
        : <IframeServicePanel sessionId={panelSessionId!} port={dynamicDef!.port} query={navParams?.query} fragment={navParams?.fragment} panelParams={dynamicDef!.panelParams} cwd={activeSessionInfo?.cwd ?? undefined} />;

      tabs.push({
        id: panelId,
        label,
        icon,
        onDragStart: (e) => startPanelDragWith(e, (pos) => {
          setServicePanelPosition(panelId, pos);
          handleCombinedTabChange(panelId);
        }),
        onClose: () => closeServicePanelById(panelId),
        content,
      });
    }
    return tabs;
  }, [activeServicePanels, tunnelSessionId, activeSessionId, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, dynamicPanels, feedRunners, resolveTunnelSessionForRunner, startPanelDragWith, setServicePanelPosition, closeServicePanelById, handleCombinedTabChange, handleToggleServicePanel, getServicePanelNavParams]);

  const panelGroups = React.useMemo(() => {
    const groups = createEmptyPanelGroups<CombinedPanelTab>();
    if (terminalPanelTab) groups[terminalPosition].push(terminalPanelTab);
    if (filesPanelTab) groups[filesPosition].push(filesPanelTab);
    if (gitPanelTab) groups[gitPosition].push(gitPanelTab);
    if (triggersPanelTab) groups[triggersPosition].push(triggersPanelTab);
    if (analyzerPanelTab) groups[analyzerPosition].push(analyzerPanelTab);
    if (artifactViewerPanelTab) groups[artifactViewerPosition].push(artifactViewerPanelTab);
    for (const tab of servicePanelTabs) groups[getServicePanelPosition(tab.id)].push(tab);
    return groups;
  }, [terminalPanelTab, terminalPosition, filesPanelTab, filesPosition, gitPanelTab, gitPosition, triggersPanelTab, triggersPosition, analyzerPanelTab, analyzerPosition, artifactViewerPanelTab, artifactViewerPosition, servicePanelTabs, getServicePanelPosition]);
  panelGroupsRef.current = panelGroups;

  // ── Derived column zone arrays ─────────────────────────────────────────────
  // Each side column orders its zones top→middle→bottom. Middle zone fills the
  // remaining vertical space; if absent, the first visible zone fills.
  const leftColZones = React.useMemo(
    () => buildColumnZones("left", panelGroups, leftTopHeight, leftBottomHeight),
    [panelGroups, leftTopHeight, leftBottomHeight],
  );

  const rightColZones = React.useMemo(
    () => buildColumnZones("right", panelGroups, rightTopHeight, rightBottomHeight),
    [panelGroups, rightTopHeight, rightBottomHeight],
  );

  const hasPanels = React.useMemo(() =>
    Object.values(panelGroups).some(g => g.length > 0),
  [panelGroups]);

  const centerTopTabs = panelGroups["center-top"];
  const centerBottomTabs = panelGroups["center-bottom"];
  const centerTopFullWidth = shouldCenterTopSpanFullWidth(panelGroups);
  const centerBottomFullWidth = shouldCenterBottomSpanFullWidth(panelGroups);

  const handleGroupPositionChange = React.useCallback((tabIds: string[], pos: PanelPosition) => {
    if (tabIds.includes("terminal")) handleTerminalPositionChange(pos);
    if (tabIds.includes("files")) handleFilesPositionChange(pos);
    if (tabIds.includes("git")) handleGitPositionChange(pos);
    if (tabIds.includes("triggers")) handleTriggersPositionChange(pos);
    for (const id of activeServicePanels) {
      if (tabIds.includes(id)) setServicePanelPosition(id, pos);
    }
  }, [handleTerminalPositionChange, handleFilesPositionChange, handleGitPositionChange, handleTriggersPositionChange, activeServicePanels, setServicePanelPosition]);

  const handleGroupDragStart = React.useCallback((tabIds: string[]) => (e: React.PointerEvent) => {
    startPanelDragWith(e, (pos) => handleGroupPositionChange(tabIds, pos));
  }, [startPanelDragWith, handleGroupPositionChange]);

  const getPanelGroupKey = React.useCallback((tabIds: string[]) => panelGroupKey(tabIds), []);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({});
  const isGroupCollapsed = React.useCallback((tabIds: string[]) => {
    return !!collapsedGroups[getPanelGroupKey(tabIds)];
  }, [collapsedGroups, getPanelGroupKey]);
  const setGroupCollapsed = React.useCallback((tabIds: string[], collapsed: boolean) => {
    const key = getPanelGroupKey(tabIds);
    setCollapsedGroups((prev) => (prev[key] === collapsed ? prev : { ...prev, [key]: collapsed }));
  }, [getPanelGroupKey]);

  const centerTopTabIds = React.useMemo(() => centerTopTabs.map((t) => t.id), [centerTopTabs]);
  const centerBottomTabIds = React.useMemo(() => centerBottomTabs.map((t) => t.id), [centerBottomTabs]);
  const centerTopCollapsed = isGroupCollapsed(centerTopTabIds);
  const centerBottomCollapsed = isGroupCollapsed(centerBottomTabIds);

  const mobilePanelTabs = React.useMemo(() => {
    return [terminalPanelTab, filesPanelTab, gitPanelTab, triggersPanelTab, analyzerPanelTab, artifactViewerPanelTab, ...servicePanelTabs].filter(Boolean) as CombinedPanelTab[];
  }, [terminalPanelTab, filesPanelTab, gitPanelTab, triggersPanelTab, analyzerPanelTab, artifactViewerPanelTab, servicePanelTabs]);

  const resolveActiveTabId = React.useCallback((tabs: CombinedPanelTab[]) => {
    return resolveActiveTabIdFromIds(tabs.map((t) => t.id), combinedActiveTab);
  }, [combinedActiveTab]);

  return {
    openPanelFromDockedButton,
    handleOpenFileInExplorer,
    pizzaPiNavActions,
    panelGroups,
    leftColZones,
    rightColZones,
    hasPanels,
    centerTopTabs,
    centerBottomTabs,
    centerTopFullWidth,
    centerBottomFullWidth,
    handleGroupPositionChange,
    handleGroupDragStart,
    isGroupCollapsed,
    setGroupCollapsed,
    centerTopTabIds,
    centerBottomTabIds,
    centerTopCollapsed,
    centerBottomCollapsed,
    mobilePanelTabs,
    resolveActiveTabId,
  };
}
