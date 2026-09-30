import * as React from "react";
import { Suspense } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { initAnimationSync } from "@/lib/synced-animation";
import { SessionSidebar, type DotState, type HubSession } from "@/components/SessionSidebar";
import { SessionViewer } from "@/components/SessionViewer";
import { DesktopHeader, MobileHeader } from "@/components/AppHeaders";
import { AuthPage } from "@/components/AuthPage";
import { authClient, type BetterAuthSession } from "@/lib/auth-client";
import { usePizzaPiSession } from "@/lib/use-pizzapi-session";
import { useRunnersFeed } from "@/lib/useRunnersFeed";
import { FrontendLogOverlay } from "@/components/FrontendLogOverlay";
import { useMobileNativeActivity } from "@/lib/mobile-native";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { PizzaLogo } from "@/components/PizzaLogo";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { CombinedPanel } from "@/components/CombinedPanel";
import { DockedPanelGroup } from "@/components/DockedPanelGroup";
import { ViewerSocketContext } from "@/lib/viewer-socket-context";
import { getViewerVisibilityPayload } from "@/lib/viewer-visibility";
import { HubSocketContext } from "@/lib/hub-socket-context";
import { useRunnerServices } from "@/hooks/useRunnerServices";
import { useRunnerData } from "@/hooks/useRunnerData";
import { SigilProvider } from "@/components/sigils/SigilContext";
import { PizzaPiNavProvider } from "@/components/sigils/PizzaPiNavContext";
import { ServicePanelButtons, ServicePanelOverflowItems } from "@/components/service-panels/ServicePanels";
import { HiddenModelsManager, modelKey } from "@/components/HiddenModelsManager";
import { DegradedBanner } from "@/components/DegradedBanner";
import { RunnerWarningBanner } from "@/components/RunnerWarningBanner";
import { VersionBanner } from "@/components/VersionBanner";
import { ButtonRail, ButtonStrip } from "@/components/session-viewer/ButtonSidebar";
import type { TodoItem, SessionUiCacheEntry } from "@/lib/types";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { useTriggerCount } from "@/hooks/useTriggerCount";
import { useButtonPosition } from "@/hooks/useButtonPosition";
import { exportToMarkdown } from "@/lib/export-markdown";
// Attention store: AttentionProvider is mounted in main.ts around <App/>
import { useAttentionIngestion } from "@/hooks/useAttentionIngestion";
import { useMobileSidebar } from "@/hooks/useMobileSidebar";
import { useBrowserNotifications } from "@/hooks/useBrowserNotifications";
import { useSessionLifecycle } from "@/lib/use-session-lifecycle";
import { createWizardSpawnHandler } from "@/lib/wizard-spawn-handler";
import { useSessionState } from "@/app/useSessionState";
import { useViewerRefs } from "@/app/useViewerRefs";
import { useSocketConfig } from "@/app/useSocketConfig";
import { useAppDialogs } from "@/app/useAppDialogs";
import { useSidebarRunners } from "@/app/useSidebarRunners";
import { useLiveSessionBadges } from "@/app/useLiveSessionBadges";
import { useAuxPanels } from "@/app/useAuxPanels";
import { useButtonDrag } from "@/app/useButtonDrag";
import { useHiddenModels } from "@/app/useHiddenModels";
import { useToasts } from "@/app/useToasts";
import { useViewerLiveness } from "@/app/useViewerLiveness";
import { useVersionCheck } from "@/app/useVersionCheck";
import { useSessionUiCache } from "@/app/useSessionUiCache";
import { useStreamingMessages } from "@/app/useStreamingMessages";
import { useSessionMetaAppliers } from "@/app/useSessionMetaAppliers";
import { useRelayEventHandler } from "@/app/useRelayEventHandler";
import { useHubSocket } from "@/app/useHubSocket";
import { useViewerSession } from "@/app/useViewerSession";
import { useSessionInput } from "@/app/useSessionInput";
import { useRemoteCommands } from "@/app/useRemoteCommands";
import { useSessionNavigationListeners } from "@/app/useSessionNavigationListeners";
import { useGlobalShortcuts } from "@/app/useGlobalShortcuts";
import { useSessionActions } from "@/app/useSessionActions";
import { useModeHome } from "@/app/useModeHome";
import { useServicePanelDock } from "@/app/useServicePanelDock";
import { useDockPanels } from "@/app/useDockPanels";
import {
  LazyChangePasswordDialog,
  LazyDeviceSetupScanner,
  LazyHistoryCommandPalette,
  LazyNewSessionWizardDialog,
  LazyRunnerManager,
  LazyShortcutsDialog,
  LazyUserPreferencesPanel,
  PanelFallback,
} from "@/app/lazy-surfaces";
import { LauncherPanelView } from "@/app/components/LauncherPanelView";
import { ToastStack } from "@/app/components/ToastStack";
import { BUTTON_DROP_ZONES, DropZoneOverlay, PANEL_DROP_ZONES } from "@/app/components/DropZoneOverlay";
import { ApiKeysSheet } from "@/app/components/ApiKeysSheet";
import { ModelSelectorDialog } from "@/app/components/ModelSelectorDialog";
import { ColumnResizeHandle, DockColumn } from "@/app/components/DockColumn";

// Sync all CSS animations (pulse, chase-spin, etc.) to the same phase globally.
initAnimationSync();

/**
 * Root shell. State and side effects live in the `@/app/*` hooks; this
 * component wires them together (hook call order below mirrors the original
 * effect ordering) and renders the layout.
 */
export function App() {
  const { data: session, isPending } = usePizzaPiSession();
  const promptRef = React.useRef<HTMLTextAreaElement>(null);
  // Drive the native badge from the attention store.
  // No-op outside the bundled Capacitor app.
  useMobileNativeActivity();
  const { runners: feedRunners, status: runnersStatus } = useRunnersFeed({
    // Only connect when auth is confirmed; reconnect if the user changes (e.g. logout → new login)
    enabled: !isPending && !!session?.user?.id,
    userId: session?.user?.id ?? undefined,
  });

  const { isMobileBundled, socketUrl, buildSocketAuth } = useSocketConfig(isPending);

  // ─── Consolidated session state ─────────────────────────────────────────────
  // clearSelection() resets this entire object in a single atomic call.
  const sessionApi = useSessionState();
  const {
    viewerSocket, messages, retryState,
    pendingQuestion, pendingPlan, pluginTrustPrompt, pendingApproval, activeToolCalls,
    mcpOAuthPastes, messageQueue, activeModel, sessionName, availableModels,
    modelSelectorOpen, agentActive, effortLevel, authSource,
    tokenUsage, providerUsage, usageRefreshing, lastHeartbeatAt,
    availableCommands, resumeSessions, resumeSessionsLoading, resumeSessionsNextCursor,
    forkMessages, forkMessagesLoading,
    goal,
  } = sessionApi.sessionState;
  const { setModelSelectorOpen, setPendingQuestion, setPendingPlan } = sessionApi;

  const [relayStatus, setRelayStatus] = React.useState<DotState>("connecting");
  const {
    showPreferences, setShowPreferences,
    showApiKeys, setShowApiKeys,
    apiKeyVersion, setApiKeyVersion,
    setupClaimOpen, setSetupClaimOpen,
    setupClaimToken,
    showRunners, setShowRunners,
    historyOpen, setHistoryOpen, historyMounted,
    selectedRunnerId, setSelectedRunnerId,
    runnerManagerInitialTab, setRunnerManagerInitialTab,
    newSessionOpen, setNewSessionOpen, newSessionMounted,
    hiddenModelsOpen, setHiddenModelsOpen,
    changePasswordOpen, setChangePasswordOpen, changePasswordMounted,
    showShortcutsHelp, setShowShortcutsHelp, shortcutsMounted,
    sessionSwitcherOpen, setSessionSwitcherOpen,
  } = useAppDialogs();

  const [liveSessions, setLiveSessions] = React.useState<HubSession[]>([]);

  // Ref kept in sync with liveSessions so openSession can look up runner IDs
  // without including liveSessions in its dependency array.
  const liveSessionsRef = React.useRef<HubSession[]>(liveSessions);
  React.useLayoutEffect(() => { liveSessionsRef.current = liveSessions; }, [liveSessions]);

  const runnersForSidebar = useSidebarRunners(session, feedRunners, liveSessions);
  const {
    sessionsAwaitingInput, setSessionsAwaitingInput,
    sessionsCompacting, setSessionsCompacting,
  } = useLiveSessionBadges(liveSessions);

  // Lifecycle hook: single owner of session phase/status/error/hydration/reconnect.
  const lifecycle = useSessionLifecycle({ liveSessions });
  const activeSessionId = lifecycle.state.activeSessionId;
  const viewerStatus = lifecycle.viewerStatus;
  const lifecycleState = lifecycle.state;
  const lifecycleRefs = lifecycle.refs;
  const setLifecycleSpawnParams = lifecycle.setSpawnParams;
  const setLifecycleStatus = lifecycle.setStatus;
  const lifecycleClearSelection = lifecycle.clearSelection;
  const lifecycleSpawnSession = lifecycle.spawnSession;

  // Derive a sessionId → sessionName map for browser notifications.
  const sessionNamesMap = React.useMemo(() => {
    const map = new Map<string, string | null>();
    for (const s of liveSessions) {
      map.set(s.sessionId, s.sessionName ?? null);
    }
    return map;
  }, [liveSessions]);

  // Fire browser Notification API alerts when a session is awaiting input
  // and the tab is hidden or the user is viewing a different session.
  useBrowserNotifications({
    sessionsAwaitingInput,
    activeSessionId,
    sessionNames: sessionNamesMap,
  });

  const panelLayout = usePanelLayout(activeSessionId);
  const {
    showTerminal, setShowTerminal,
    terminalColumnRef,
    handleTerminalPositionChange,
    panelDragActive, panelDragZone,
    handleOuterPointerMove, handleOuterPointerUp,
    handleCombinedTabChange,
    showFileExplorer, setShowFileExplorer,
    handleFilesPositionChange,
    showGit, setShowGit,
    handleGitPositionChange,
    leftColumnWidth, rightColumnWidth,
    centerTopHeight, centerBottomHeight,
    startColumnWidthResize, startZoneHeightResize,
    showTriggers, setShowTriggers,
    handleTriggersPositionChange,
  } = panelLayout;

  const auxPanels = useAuxPanels();
  const { showAnalyzer, setShowAnalyzer, handleAnalyzerPositionChange, setArtifactViewer } = auxPanels;

  const buttonPositions = useButtonPosition();
  const { draggingButton, buttonDragZone, handleButtonDragStart } = useButtonDrag(buttonPositions, terminalColumnRef);

  const { hiddenModels, setHiddenModels } = useHiddenModels(session);

  // Live session status from heartbeats (isCompacting and planModeEnabled are intentionally
  // NOT part of SessionState because they are not reset by clearSelection)
  const [isCompacting, setIsCompacting] = React.useState(false);
  const [planModeEnabled, setPlanModeEnabled] = React.useState(false);
  const [todoList, setTodoList] = React.useState<TodoItem[]>([]);
  const [analysis, setAnalysis] = React.useState<SessionUiCacheEntry["analysis"]>(null);

  // Keyboard shortcuts
  const isMac = React.useMemo(() => {
    const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
    return /Mac|iPhone|iPad/i.test(platform);
  }, []);

  // PATCH(pizzapi): Toast notification state for ctx.ui.notify() events
  const { toasts, pushToast, dismissToast } = useToasts();

  // Socket-handler refs (sequence cursor, watchdog timers, meta versions, …).
  const refs = useViewerRefs();
  const staleThresholdMsRef = useViewerLiveness(refs);

  // Mobile layout
  const {
    sidebarOpen, setSidebarOpen,
    sidebarSwipeOffset, suppressOverlayClickRef,
    handleSidebarPointerDown, handleSidebarPointerMove, handleSidebarPointerUp,
  } = useMobileSidebar();

  const { versionBanner, checkVersionCompatibility } = useVersionCheck(session, isMobileBundled);

  // Cache last-known UI state per relay session so switching sessions feels instant.
  const { sessionUiCacheRef, requestedSnapshotMessagesRef, patchSessionCache } =
    useSessionUiCache(lifecycleRefs, setSessionsAwaitingInput);

  const streaming = useStreamingMessages(sessionApi.setMessages);

  const appliers = useSessionMetaAppliers({
    session: sessionApi,
    refs,
    lifecycleRefs,
    setLifecycleStatus,
    patchSessionCache,
    setTodoList,
    setPlanModeEnabled,
    setIsCompacting,
    setSessionsCompacting,
  });
  const { appendLocalSystemMessage } = appliers;

  const handleRelayEvent = useRelayEventHandler({
    session: sessionApi,
    refs,
    lifecycle,
    streaming,
    appliers,
    requestedSnapshotMessagesRef,
    patchSessionCache,
    setTodoList,
    setPlanModeEnabled,
    setIsCompacting,
    setAnalysis,
    setSessionsCompacting,
    setArtifactViewer,
  });

  // Only connect once auth is confirmed — a pre-login handshake is rejected by
  // the server middleware and socket.io never retries middleware denials, which
  // left the hub socket permanently dead until a full page reload (stuck
  // sidebar skeletons + "Connecting…"). Keyed on the user id so logout→login
  // recreates the socket. Mirrors useRunnersFeed's `enabled` gating.
  const hubAuthUserId = !isPending && session?.user?.id ? String(session.user.id) : null;

  const hubSocket = useHubSocket({
    hubAuthUserId,
    socketUrl,
    buildSocketAuth,
    refs,
    lifecycleRefs,
    activeSessionId,
    liveSessions,
    appliers,
    checkVersionCompatibility,
    pushToast,
    setSessionsAwaitingInput,
    setSessionsCompacting,
  });

  const { openSession, clearSelection, loadingOlderMessages, setLoadingOlderMessages } = useViewerSession({
    session: sessionApi,
    refs,
    lifecycle,
    streaming,
    handleRelayEvent,
    patchSessionCache,
    sessionUiCacheRef,
    requestedSnapshotMessagesRef,
    liveSessions,
    liveSessionsRef,
    staleThresholdMsRef,
    socketUrl,
    buildSocketAuth,
    setTodoList,
    setPlanModeEnabled,
    setIsCompacting,
    setAnalysis,
    setArtifactViewer,
  });

  const { sendSessionInput, requestOlderMessages } = useSessionInput({
    session: sessionApi,
    refs,
    lifecycle,
    patchSessionCache,
    isCompacting,
    loadingOlderMessages,
    setLoadingOlderMessages,
  });

  const {
    sendRemoteExec,
    respondPluginTrust,
    handleEndSession,
    requestResumeSessions,
    requestForkMessages,
    refreshUsage,
    removeQueuedMessage,
    editQueuedMessage,
    clearMessageQueue,
    selectModel,
  } = useRemoteCommands({
    session: sessionApi,
    refs,
    lifecycle,
    patchSessionCache,
    setLiveSessions,
    socketUrl,
    buildSocketAuth,
  });

  const handleOpenSession = React.useCallback((id: string) => {
    setShowRunners(false);
    openSession(id);
    setSidebarOpen(false);
  }, [openSession]);

  useSessionNavigationListeners(handleOpenSession);

  const handleClearSelection = React.useCallback(() => {
    setShowRunners(false);
    clearSelection();
    setSidebarOpen(false);
  }, [clearSelection]);

  // Global keyboard shortcuts
  useGlobalShortcuts({
    isMac,
    agentActive,
    lifecycleRefs,
    promptRef,
    sendRemoteExec,
    setShowShortcutsHelp,
    setShowTerminal,
    setShowFileExplorer,
    setHistoryOpen,
  });

  const handleNewSession = React.useCallback((initialCwd?: string) => {
    setLifecycleSpawnParams({ runnerId: undefined, preselectedRunnerId: null, cwd: typeof initialCwd === "string" ? initialCwd : "" });
    setNewSessionOpen(true);
  }, [setLifecycleSpawnParams]);

  const handleDuplicateSession = React.useCallback((runnerId: string, cwd: string) => {
    setLifecycleSpawnParams({ runnerId, preselectedRunnerId: runnerId, cwd });
    setNewSessionOpen(true);
  }, [setLifecycleSpawnParams]);

  const handleExport = React.useCallback(() => {
    if (!messages.length) return;
    const blob = new Blob([exportToMarkdown(messages)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${activeSessionId || "export"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages, activeSessionId]);

  // ── Session live waiter is now owned by useSessionLifecycle. ──────────

  /** Spawn handler for the new wizard dialog. */
  const handleWizardSpawn = React.useCallback(
    createWizardSpawnHandler({
      spawnSession: lifecycleSpawnSession,
      openSession: handleOpenSession,
      setOpen: setNewSessionOpen,
    }),
    [lifecycleSpawnSession, handleOpenSession, setNewSessionOpen],
  );

  // Derive runner/cwd for the active session (used by File Explorer)
  const activeSessionInfo = React.useMemo(() => {
    if (!activeSessionId) return null;
    const liveSession = liveSessions.find((s) => s.sessionId === activeSessionId);
    if (!liveSession) return null;
    return {
      runnerId: liveSession.runnerId ?? null,
      cwd: liveSession.cwd ?? "",
    };
  }, [activeSessionId, liveSessions]);

  const {
    handleTriggerResponse,
    handleSpawnAgentSession,
    handleApprovalDecision,
    handleMcpOAuthPaste,
    handleMcpOAuthPasteDismiss,
    handleMcpServerDisable,
    handleResumeFromHistory,
  } = useSessionActions({
    session: sessionApi,
    refs,
    lifecycle,
    patchSessionCache,
    sendSessionInput,
    activeSessionId,
    activeSessionInfo,
    liveSessions,
    handleOpenSession,
    setHistoryOpen,
  });

  const activeRunnerInfo = useRunnerData(feedRunners, activeSessionInfo?.runnerId);

  // Runner service panels — dynamically discovered
  const { services: availableServices, disabledServices: disabledServiceIds, panels: dynamicPanels, sigilDefs: runnerSigilDefs } = useRunnerServices(viewerSocket, activeRunnerInfo);
  const triggerCounts = useTriggerCount(activeSessionId, viewerSocket);

  const {
    modesSource,
    effectiveSessionModes,
    activeMode,
    modeUi,
    modePanels,
    launcherSource,
    selectedModeId,
    setSelectedModeId,
    selectedMode,
    selectedModeUi,
    startingTask,
    openLauncherPanelId,
    handleOpenLauncherPanel,
    handleCloseLauncherPanel,
    selectedModeSessions,
    visibleScheduledInstructions,
    scheduledLoading,
    scheduledFailed,
    scheduleRunnerId,
    handleStartModeTask,
    modeVisibleServices,
  } = useModeHome({
    feedRunners,
    activeRunnerInfo,
    activeSessionInfo,
    liveSessions,
    dynamicPanels,
    availableServices,
    selectedRunnerId,
    lifecycleSpawnSession,
    setLifecycleStatus,
    handleOpenSession,
    setShowGit,
    setShowTerminal,
    setShowFileExplorer,
  });

  const attentionSessionNames = React.useMemo(() => {
    const names = new Map<string, string>();
    for (const session of liveSessions) {
      const name = session.sessionName?.trim();
      if (name) {
        names.set(session.sessionId, name);
      }
    }
    if (activeSessionId && sessionName?.trim()) {
      names.set(activeSessionId, sessionName.trim());
    }
    return names;
  }, [activeSessionId, liveSessions, sessionName]);

  // Feed session meta + trigger data into the attention store
  useAttentionIngestion({
    activeSessionId,
    pendingQuestion,
    pendingPlan,
    pluginTrustPrompt,
    isCompacting,
    agentActive,
    sessionName,
    triggerCounts,
    sessionsAwaitingInput,
    sessionsCompacting,
    sessionNamesById: attentionSessionNames,
  });

  const serviceDock = useServicePanelDock({
    viewerSocket,
    lifecycleRefs,
    activeSessionInfo,
    feedRunners,
    dynamicPanels,
    modePanels,
    modeVisibleServices,
    disabledServiceIds,
    combinedActiveTab: panelLayout.combinedActiveTab,
    handleCombinedTabChange,
    buttonPositions,
  });
  const {
    handleToggleServicePanel,
    railServicePanels,
    servicePanelButtonActiveIds,
    handleToggleServicePanelFromDock,
  } = serviceDock;

  // Tell the server whether the tab is actually being looked at, so it can
  // suppress native push while a viewer is visible. "Visible" ignores window
  // focus on purpose — a session on a second monitor still counts as viewed.
  React.useEffect(() => {
    if (!viewerSocket) return;
    const emitVisibility = () => {
      viewerSocket.emit("viewer_visibility", getViewerVisibilityPayload());
    };
    document.addEventListener("visibilitychange", emitVisibility);
    return () => document.removeEventListener("visibilitychange", emitVisibility);
  }, [viewerSocket]);

  const {
    openPanelFromDockedButton,
    handleOpenFileInExplorer,
    pizzaPiNavActions,
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
  } = useDockPanels({
    panelLayout,
    auxPanels,
    serviceDock,
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
  });

  // Stable callbacks for memoized header components.
  //
  // Important: these hooks must stay ABOVE the auth/loading early returns
  // below. Moving them under `if (isPending)` / `if (!session)` changes the
  // number of hooks executed between renders and triggers React error #310
  // (“Rendered more hooks than during the previous render”).
  //
  // Keeping them here also preserves referential stability so React.memo can
  // skip re-rendering when only session-scoped state changes.

  const handleShowPreferences = React.useCallback(() => setShowPreferences(true), []);
  const handleShowApiKeys = React.useCallback(() => { setShowApiKeys(true); setShowRunners(false); }, []);
  const handleShowRunners = React.useCallback(() => { setShowRunners(true); setShowApiKeys(false); lifecycleClearSelection(); }, [lifecycleClearSelection]);
  const handleShowShortcuts = React.useCallback(() => setShowShortcutsHelp(true), []);
  const handleChangePassword = React.useCallback(() => setChangePasswordOpen(true), []);
  const handleToggleSidebar = React.useCallback(() => setSidebarOpen((prev) => !prev), []);

  // Escape closes the mobile sidebar drawer (keyboard/a11y parity with the
  // backdrop tap). Only active while the drawer is open; a dialog open on top
  // owns Escape first, so skip when one is present.
  React.useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen, setSidebarOpen]);

  // Mobile-specific variants that also close the sidebar
  const handleMobileShowPreferences = React.useCallback(() => { setShowPreferences(true); setSidebarOpen(false); }, []);
  const handleMobileShowApiKeys = React.useCallback(() => { setShowApiKeys(true); setShowRunners(false); setSidebarOpen(false); }, []);
  const handleMobileShowRunners = React.useCallback(() => { setShowRunners(true); setShowApiKeys(false); lifecycleClearSelection(); setSidebarOpen(false); }, [lifecycleClearSelection]);
  const handleMobileChangePassword = React.useCallback(() => { setChangePasswordOpen(true); setSidebarOpen(false); }, []);
  const handleSessionSwitcherOpenChange = React.useCallback((open: boolean) => setSessionSwitcherOpen(open), []);

  if (isPending) {
    return (
      <div className="flex h-[100dvh] w-full items-center justify-center bg-background animate-in fade-in duration-300">
        <div className="flex flex-col items-center gap-4">
          <PizzaLogo className="h-16 w-16 sm:h-20 sm:w-20" />
          <Spinner className="size-5 text-primary/60" />
        </div>
      </div>
    );
  }

  if (!session) {
    return <AuthPage onAuthenticated={() => authClient.$store.notify("$sessionSignal")} />
  }

  const rawUser = (session as BetterAuthSession | null)?.user;
  const userName = rawUser && typeof rawUser.name === "string" ? (rawUser.name as string) : "";
  const userEmail = rawUser && typeof rawUser.email === "string" ? (rawUser.email as string) : "";
  const userLabel = userName || userEmail || "Account";

  // Shared by the left/right rails and the top/bottom strips.
  const dockButtonProps = {
    onDragStart: handleButtonDragStart,
    servicePanels: railServicePanels,
    disabledServiceIds,
    onToggleServicePanel: handleToggleServicePanelFromDock,
    onToggleTerminal: () => openPanelFromDockedButton("terminal", showTerminal, setShowTerminal, handleTerminalPositionChange),
    onToggleFileExplorer: () => openPanelFromDockedButton("files", showFileExplorer, setShowFileExplorer, handleFilesPositionChange),
    onToggleGit: () => openPanelFromDockedButton("git", showGit, setShowGit, handleGitPositionChange),
    onToggleTriggers: () => openPanelFromDockedButton("triggers", showTriggers, setShowTriggers, handleTriggersPositionChange),
    onToggleAnalyzer: () => openPanelFromDockedButton("analyzer", showAnalyzer, setShowAnalyzer, handleAnalyzerPositionChange),
    onDuplicateSession: activeSessionInfo?.runnerId ? () => handleDuplicateSession(activeSessionInfo.runnerId!, activeSessionInfo.cwd || "") : undefined,
    onExport: handleExport,
    onExec: sendRemoteExec,
    sessionId: activeSessionId,
    effortLevel,
    planModeEnabled,
    tokenUsage,
  };

  return (
    <ThemeProvider>
    <HubSocketContext.Provider value={hubSocket}>
    <ViewerSocketContext.Provider value={viewerSocket}>
    <TooltipProvider delayDuration={0}>
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background pp-safe-left pp-safe-right">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground"
      >
        Skip to content
      </a>
      {/* Single page-level heading for screen-reader landmarks/outline. */}
      <h1 className="sr-only">PizzaPi</h1>
      {/* ── Desktop header (memoized — skips re-render on same-runner session switch) ── */}
      <DesktopHeader
        relayStatus={relayStatus}
        providerUsage={providerUsage}
        authSource={authSource}
        activeProvider={activeModel?.provider}
        usageRefreshing={usageRefreshing}
        userName={userName}
        userEmail={userEmail}
        userLabel={userLabel}
        onShowPreferences={handleShowPreferences}
        onShowApiKeys={handleShowApiKeys}
        onShowRunners={handleShowRunners}
        onShowShortcuts={handleShowShortcuts}
        onChangePassword={handleChangePassword}
        onRefreshUsage={refreshUsage}
        onShowHistory={() => setHistoryOpen(true)}
      />

      {/* ── Mobile header (memoized — skips re-render on same-runner session switch) ── */}
      <MobileHeader
        relayStatus={relayStatus}
        sidebarOpen={sidebarOpen}
        providerUsage={providerUsage}
        authSource={authSource}
        usageRefreshing={usageRefreshing}
        activeSessionId={activeSessionId}
        agentActive={agentActive}
        sessionName={sessionName}
        activeModel={activeModel}
        liveSessions={liveSessions}
        sessionSwitcherOpen={sessionSwitcherOpen}
        userName={userName}
        userEmail={userEmail}
        userLabel={userLabel}
        onToggleSidebar={handleToggleSidebar}
        onShowPreferences={handleMobileShowPreferences}
        onShowApiKeys={handleMobileShowApiKeys}
        onShowRunners={handleMobileShowRunners}
        onChangePassword={handleMobileChangePassword}
        onRefreshUsage={refreshUsage}
        onOpenSession={handleOpenSession}
        onNewSession={handleNewSession}
        onSessionSwitcherOpenChange={handleSessionSwitcherOpenChange}
        needsResponseCount={sessionsAwaitingInput.size}
        onShowHistory={() => setHistoryOpen(true)}
      />
      {/* Spacer that reserves the exact height of the fixed mobile header */}
      <div className="md:hidden flex-shrink-0" style={{ height: "calc(3.25rem + env(safe-area-inset-top))" }} aria-hidden="true" />

      {/* Banners render after the mobile header spacer so they're visible below
          the fixed mobile header. On desktop (where there is no spacer) they
          appear directly below the DesktopHeader. */}
      <DegradedBanner relayStatus={relayStatus} />
      <RunnerWarningBanner runners={feedRunners} />
      <VersionBanner message={versionBanner.message} protocolCompatible={versionBanner.protocolCompatible} />

      {/* Mobile model selector (shared with desktop) */}
      <ModelSelectorDialog
        open={modelSelectorOpen}
        onOpenChange={setModelSelectorOpen}
        activeModel={activeModel}
        availableModels={availableModels}
        hiddenModels={hiddenModels}
        onSelectModel={selectModel}
        onManageVisibility={() => { setModelSelectorOpen(false); setHiddenModelsOpen(true); }}
      />

      {/* Hidden models manager dialog */}
      <HiddenModelsManager
        open={hiddenModelsOpen}
        onOpenChange={setHiddenModelsOpen}
        models={availableModels}
        hiddenModels={hiddenModels}
        onHiddenModelsChange={setHiddenModels}
      />

      {changePasswordMounted && (
        <Suspense fallback={<PanelFallback label="Password" />}>
          <LazyChangePasswordDialog
            open={changePasswordOpen}
            onOpenChange={setChangePasswordOpen}
          />
        </Suspense>
      )}

      <div className="pp-shell flex flex-1 min-h-0 overflow-hidden relative">
        <div
          className={
            "pp-sidebar-wrap absolute inset-y-0 left-0 z-40 w-72 max-w-[85vw] border-r border-sidebar-border bg-sidebar shadow-2xl md:static md:z-auto md:w-auto md:max-w-none md:border-r-0 md:bg-transparent md:shadow-none will-change-transform " +
            (sidebarSwipeOffset !== 0 ? "" : "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:transition-none ") +
            (sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0")
          }
          style={sidebarSwipeOffset !== 0 ? { transform: `translateX(${sidebarSwipeOffset}px)` } : undefined}
        >
          <ErrorBoundary level="section" resetKeys={[activeSessionId]}>
            <SessionSidebar
              onOpenSession={handleOpenSession}
              onNewSession={handleNewSession}
              sessionModes={effectiveSessionModes}
              sessionModesRunnerId={modesSource.runnerId}
              selectedModeId={selectedModeId}
              onSelectedModeChange={setSelectedModeId}
              onClearSelection={handleClearSelection}
              onShowRunners={() => { setShowRunners(true); setShowApiKeys(false); lifecycleClearSelection(); }}
              activeSessionId={activeSessionId}
              showRunners={showRunners}
              activeModel={activeModel}
              onRelayStatusChange={setRelayStatus}
              onSessionsChange={setLiveSessions}
              onClose={() => setSidebarOpen(false)}
              onEndSession={handleEndSession}
              onDuplicateSession={handleDuplicateSession}
              runners={runnersForSidebar}
              selectedRunnerId={selectedRunnerId}
              onSelectRunner={setSelectedRunnerId}
              onShowSessions={() => setShowRunners(false)}
              sessionsAwaitingInput={sessionsAwaitingInput}
              sessionsCompacting={sessionsCompacting}
              dynamicPanels={launcherSource.panels}
              onOpenLauncherPanel={handleOpenLauncherPanel}
              activeLauncherId={openLauncherPanelId}
            />
          </ErrorBoundary>
        </div>

        {/* Mobile overlay — fades in/out with the sidebar.
            Swipe left anywhere on the backdrop to close; tap to close instantly. */}
        <div
          className={cn(
            "pp-sidebar-overlay absolute inset-0 z-30 bg-black/50 md:hidden transition-opacity duration-300",
            sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          )}
          style={{ touchAction: 'none' }}
          onPointerDown={sidebarOpen ? handleSidebarPointerDown : undefined}
          onPointerMove={sidebarOpen ? handleSidebarPointerMove : undefined}
          onPointerUp={sidebarOpen ? handleSidebarPointerUp : undefined}
          onPointerCancel={sidebarOpen ? handleSidebarPointerUp : undefined}
          onClick={() => {
            if (suppressOverlayClickRef.current) { suppressOverlayClickRef.current = false; return; }
            setSidebarOpen(false);
          }}
          aria-hidden="true"
        />

        <div
          ref={terminalColumnRef}
          className="relative flex flex-1 min-w-0 h-full overflow-hidden flex-col"
          onPointerMove={hasPanels ? handleOuterPointerMove : undefined}
          onPointerUp={hasPanels ? handleOuterPointerUp : undefined}
          onPointerCancel={hasPanels ? handleOuterPointerUp : undefined}
        >
          {/* center-top spans full width when no left/right top panels exist */}
          {/* ponytail: no explicit height here — DockedPanelGroup already sizes its panel via inline style and appends a 5px resize handle; a fixed wrapper height clipped that handle under the session header */}
          {centerTopFullWidth && (
            <div className="hidden md:flex flex-col shrink-0">
              <DockedPanelGroup
                position="center-top"
                size={centerTopHeight}
                tabs={centerTopTabs}
                activeTabId={resolveActiveTabId(centerTopTabs)}
                onActiveTabChange={handleCombinedTabChange}
                onPositionChange={(pos) => handleGroupPositionChange(centerTopTabIds, pos)}
                onDragStart={handleGroupDragStart(centerTopTabIds)}
                onResizeStart={(e) => startZoneHeightResize("center-top", e)}
                collapsed={centerTopCollapsed}
                onCollapseChange={(next) => setGroupCollapsed(centerTopTabIds, next)}
                className="h-full w-full"
              />
            </div>
          )}

          <div className="flex flex-1 min-w-0 h-full overflow-hidden">
            {/* ── LEFT ICON RAIL ──────────────────────────────────────────── */}
            {/* ponytail: rail lives outside the panel column so it stays pinned next to the session list; the panel slides out between it and the chat */}
            <ButtonRail
              side="left"
              groups={{ top: buttonPositions.slots["left-top"], middle: buttonPositions.slots["left-middle"], bottom: buttonPositions.slots["left-bottom"] }}
              {...dockButtonProps}
            />

            {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
            {leftColZones.length > 0 && (
              <>
                <DockColumn
                  zones={leftColZones}
                  width={leftColumnWidth}
                  isGroupCollapsed={isGroupCollapsed}
                  setGroupCollapsed={setGroupCollapsed}
                  resolveActiveTabId={resolveActiveTabId}
                  onActiveTabChange={handleCombinedTabChange}
                  onGroupPositionChange={handleGroupPositionChange}
                  onGroupDragStart={handleGroupDragStart}
                  startZoneHeightResize={startZoneHeightResize}
                />
                <ColumnResizeHandle onPointerDown={(e) => startColumnWidthResize("left", e)} />
              </>
            )}

            {/* ── CENTER COLUMN ───────────────────────────────────────────── */}
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              {/* ── TOP ICON STRIP ───────────────────────────────────────── */}
              {/* ponytail: strip lives outside the docked panel so it stays pinned to the top edge; the panel slides out beneath it */}
              <ButtonStrip
                position="center-top"
                buttonIds={buttonPositions.slots["center-top"]}
                {...dockButtonProps}
              />

              {/* center-top zone */}
              {!centerTopFullWidth && centerTopTabs.length > 0 && (
                <DockedPanelGroup
                  position="center-top"
                  size={centerTopHeight}
                  tabs={centerTopTabs}
                  activeTabId={resolveActiveTabId(centerTopTabs)}
                  onActiveTabChange={handleCombinedTabChange}
                  onPositionChange={(pos) => handleGroupPositionChange(centerTopTabIds, pos)}
                  onDragStart={handleGroupDragStart(centerTopTabIds)}
                  onResizeStart={(e) => startZoneHeightResize("center-top", e)}
                  collapsed={centerTopCollapsed}
                  onCollapseChange={(next) => setGroupCollapsed(centerTopTabIds, next)}
                  className="w-full"
                />
              )}

              {/* ── Center content ───────────────────────────────────────── */}
              <div id="main-content" role="main" tabIndex={-1} className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
                  {openLauncherPanelId ? (
                    <LauncherPanelView
                      panelId={openLauncherPanelId}
                      panels={launcherSource.panels}
                      runnerId={launcherSource.runnerId}
                      onClose={handleCloseLauncherPanel}
                    />
                  ) : showRunners ? (
                    <ErrorBoundary level="section" resetKeys={[activeSessionId]}>
                      <Suspense fallback={<PanelFallback label="Runners" />}>
                        <LazyRunnerManager
                          runners={feedRunners}
                          runnersStatus={runnersStatus}
                          sessions={liveSessions}
                          onOpenSession={(id) => { handleOpenSession(id); setShowRunners(false); }}
                          selectedRunnerId={selectedRunnerId}
                          onSelectRunner={setSelectedRunnerId}
                          initialTab={runnerManagerInitialTab}
                        />
                      </Suspense>
                    </ErrorBoundary>
                  ) : (
                    <ErrorBoundary level="section" resetKeys={[activeSessionId]}>
                      <SigilProvider sigilDefs={runnerSigilDefs} panels={dynamicPanels} runnerId={activeSessionInfo?.runnerId ?? undefined} runnerOnline={runnersStatus === "connected" && activeRunnerInfo !== null} sessionCwd={activeSessionInfo?.cwd}>
                      <PizzaPiNavProvider actions={pizzaPiNavActions}>
                      <SessionViewer
                        promptRef={promptRef}
                        sessionId={activeSessionId}
                        sessionName={sessionName}
                        messages={messages}
                        activeModel={activeModel}
                        activeToolCalls={activeToolCalls}
                        pendingQuestion={pendingQuestion}
                        pendingPlan={pendingPlan}
                        pluginTrustPrompt={pluginTrustPrompt}
                        onPluginTrustResponse={respondPluginTrust}
                        pendingApproval={pendingApproval}
                        onApprovalDecision={handleApprovalDecision}
                        availableCommands={availableCommands}
                        resumeSessions={resumeSessions}
                        resumeSessionsLoading={resumeSessionsLoading}
                        onRequestResumeSessions={requestResumeSessions}
                        forkMessages={forkMessages}
                        forkMessagesLoading={forkMessagesLoading}
                        onRequestForkMessages={requestForkMessages}
                        onSendInput={sendSessionInput}
                        onExec={sendRemoteExec}
                        onShowModelSelector={() => setModelSelectorOpen(true)}
                        onNewSession={handleNewSession}
                        agentActive={agentActive}
                        isCompacting={isCompacting}
                        effortLevel={effortLevel}
                        tokenUsage={tokenUsage}
                        lastHeartbeatAt={lastHeartbeatAt}
                        viewerStatus={viewerStatus}
                        retryState={retryState}
                        messageQueue={messageQueue}
                        onRemoveQueuedMessage={removeQueuedMessage}
                        onEditQueuedMessage={editQueuedMessage}
                        onClearMessageQueue={clearMessageQueue}
                        onToggleTerminal={() => setShowTerminal((v) => !v)}
                        showTerminalButton={modeUi.terminal}
                        isTerminalOpen={showTerminal}
                        onToggleFileExplorer={() => setShowFileExplorer((v) => !v)}
                        showFileExplorerButton={modeUi.files && !!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd}
                        isFileExplorerOpen={showFileExplorer}
                        onToggleGit={() => setShowGit((v) => !v)}
                        showGitButton={modeUi.git && !!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd}
                        isGitOpen={showGit}
                        modeUi={modeUi}
                        modeLabel={activeMode?.label}
                        modeIcon={activeMode?.icon}
                        onOpenArtifact={modeUi.files ? handleOpenFileInExplorer : undefined}
                        onOpenArtifactViewer={(a) => { setArtifactViewer(a); handleCombinedTabChange("artifact-viewer"); }}
                        modeHome={selectedMode ? {
                          label: selectedMode.label,
                          icon: selectedMode.icon,
                          ui: selectedModeUi,
                          recentSessions: selectedModeSessions.map((s) => ({
                            sessionId: s.sessionId,
                            sessionName: s.sessionName ?? null,
                            cwd: s.cwd,
                            lastHeartbeatAt: s.lastHeartbeatAt ?? null,
                            startedAt: s.startedAt,
                            isActive: s.isActive ?? false,
                          })),
                          busy: startingTask,
                          onStartTask: (prompt: string) => { void handleStartModeTask(prompt); },
                          onOpenSession: handleOpenSession,
                          onOpenTriggerManager: () => {
                            if (scheduleRunnerId) setSelectedRunnerId(scheduleRunnerId);
                            setRunnerManagerInitialTab("triggers");
                            setShowRunners(true);
                          },
                          scheduled: selectedModeUi.scheduled ? {
                            instructions: visibleScheduledInstructions,
                            loading: scheduledLoading,
                            failed: scheduledFailed,
                          } : undefined,
                        } : undefined}
                        onToggleTriggers={() => setShowTriggers((v) => !v)}
                        showTriggersButton={!!activeSessionId}
                        isTriggersOpen={showTriggers}
                        onToggleAnalyzer={() => setShowAnalyzer((v) => !v)}
                        showAnalyzerButton={!!activeSessionId}
                        isAnalyzerOpen={showAnalyzer}
                        triggerCount={triggerCounts}
                        hasMoreServerMessages={refs.paginationStateRef.current?.hasMore ?? false}
                        onLoadMoreServerMessages={requestOlderMessages}
                        loadingOlderMessages={loadingOlderMessages}
                        extraHeaderButtons={
                          <ServicePanelButtons
                            availableServices={modeVisibleServices}
                            disabledServiceIds={disabledServiceIds}
                            dynamicPanels={modePanels}
                            activePanelIds={servicePanelButtonActiveIds}
                            onTogglePanel={handleToggleServicePanel}
                            onButtonDragStart={handleButtonDragStart}
                            toolbarPositions={buttonPositions.positions}
                          />
                        }
                        extraOverflowItems={
                          <ServicePanelOverflowItems
                            availableServices={modeVisibleServices}
                            disabledServiceIds={disabledServiceIds}
                            dynamicPanels={modePanels}
                            activePanelIds={servicePanelButtonActiveIds}
                            onTogglePanel={handleToggleServicePanel}
                          />
                        }
                        todoList={todoList}
                        goal={goal}
                        analysis={analysis}
                        planModeEnabled={planModeEnabled}
                        runnerId={activeSessionInfo?.runnerId ?? undefined}
                        sessionCwd={activeSessionInfo?.cwd || undefined}
                        onAppendSystemMessage={appendLocalSystemMessage}
                        onSpawnAgentSession={handleSpawnAgentSession}
                        onTriggerResponse={handleTriggerResponse}
                        onQuestionDismiss={() => setPendingQuestion(null)}
                        onPlanDismiss={() => setPendingPlan(null)}
                        onDuplicateSession={activeSessionInfo?.runnerId ? () => handleDuplicateSession(activeSessionInfo.runnerId!, activeSessionInfo.cwd || "") : undefined}
                        runnerInfo={activeRunnerInfo}
                        mcpOAuthPastes={mcpOAuthPastes}
                        onMcpOAuthPaste={handleMcpOAuthPaste}
                        onMcpOAuthPasteDismiss={handleMcpOAuthPasteDismiss}
                        onMcpServerDisable={handleMcpServerDisable}
                        onButtonDragStart={handleButtonDragStart}
                        toolbarPositions={buttonPositions.positions}
                      />
                      </PizzaPiNavProvider>
                      </SigilProvider>
                    </ErrorBoundary>
                  )}
                </div>

              {/* center-bottom zone */}
              {!centerBottomFullWidth && centerBottomTabs.length > 0 && (
                <DockedPanelGroup
                  position="center-bottom"
                  size={centerBottomHeight}
                  tabs={centerBottomTabs}
                  activeTabId={resolveActiveTabId(centerBottomTabs)}
                  onActiveTabChange={handleCombinedTabChange}
                  onPositionChange={(pos) => handleGroupPositionChange(centerBottomTabIds, pos)}
                  onDragStart={handleGroupDragStart(centerBottomTabIds)}
                  onResizeStart={(e) => startZoneHeightResize("center-bottom", e)}
                  collapsed={centerBottomCollapsed}
                  onCollapseChange={(next) => setGroupCollapsed(centerBottomTabIds, next)}
                  className="w-full"
                />
              )}

            </div>{/* end center column */}

            {/* ── RIGHT COLUMN ────────────────────────────────────────────── */}
            {rightColZones.length > 0 && (
              <>
                <ColumnResizeHandle onPointerDown={(e) => startColumnWidthResize("right", e)} />
                <DockColumn
                  zones={rightColZones}
                  width={rightColumnWidth}
                  isGroupCollapsed={isGroupCollapsed}
                  setGroupCollapsed={setGroupCollapsed}
                  resolveActiveTabId={resolveActiveTabId}
                  onActiveTabChange={handleCombinedTabChange}
                  onGroupPositionChange={handleGroupPositionChange}
                  onGroupDragStart={handleGroupDragStart}
                  startZoneHeightResize={startZoneHeightResize}
                />
              </>
            )}

            {/* ── RIGHT ICON RAIL ─────────────────────────────────────────── */}
            {/* ponytail: rail lives outside the panel column so it stays pinned to the right edge; the panel slides out between the chat and it */}
            <ButtonRail
              side="right"
              groups={{ top: buttonPositions.slots["right-top"], middle: buttonPositions.slots["right-middle"], bottom: buttonPositions.slots["right-bottom"] }}
              {...dockButtonProps}
            />
          </div>

          {/* ponytail: same fix as center-top — let the panel + handle define the wrapper's height */}
          {centerBottomFullWidth && (
            <div className="hidden md:flex flex-col shrink-0">
              <DockedPanelGroup
                position="center-bottom"
                size={centerBottomHeight}
                tabs={centerBottomTabs}
                activeTabId={resolveActiveTabId(centerBottomTabs)}
                onActiveTabChange={handleCombinedTabChange}
                onPositionChange={(pos) => handleGroupPositionChange(centerBottomTabIds, pos)}
                onDragStart={handleGroupDragStart(centerBottomTabIds)}
                onResizeStart={(e) => startZoneHeightResize("center-bottom", e)}
                collapsed={centerBottomCollapsed}
                onCollapseChange={(next) => setGroupCollapsed(centerBottomTabIds, next)}
                className="h-full w-full"
              />
            </div>
          )}

          {/* ── BOTTOM ICON STRIP ────────────────────────────────────── */}
          {/* ponytail: render after the side rails so the strip owns the true bottom-left/right corners */}
          <ButtonStrip
            position="center-bottom"
            buttonIds={buttonPositions.slots["center-bottom"]}
            {...dockButtonProps}
          />

          {/* ── MOBILE OVERLAY ──────────────────────────────────────────── */}
          {mobilePanelTabs.length > 0 && (
            <div
              className="md:hidden fixed inset-0 z-[60] flex flex-col bg-background pp-safe-left pp-safe-right"
              style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              <CombinedPanel
                activeTabId={resolveActiveTabId(mobilePanelTabs)}
                onActiveTabChange={handleCombinedTabChange}
                position="center-bottom"
                className="h-full"
                tabs={mobilePanelTabs}
              />
            </div>
          )}

          {/* ── BUTTON DRAG OVERLAY (3×3) ──────────────────────── */}
          {draggingButton && (
            <DropZoneOverlay
              zones={BUTTON_DROP_ZONES}
              activeZone={buttonDragZone}
              className="absolute inset-0 z-50 pointer-events-none grid grid-cols-3 grid-rows-3"
            />
          )}

          {/* ── 3×3 DRAG OVERLAY ────────────────────────────────────────── */}
          {panelDragActive && (
            <DropZoneOverlay
              zones={PANEL_DROP_ZONES}
              activeZone={panelDragZone}
              className="absolute inset-0 z-50 pointer-events-none hidden md:grid grid-cols-3 grid-rows-3"
            />
          )}
        </div>
        {historyMounted && (
          <Suspense fallback={<PanelFallback label="History" />}>
            <LazyHistoryCommandPalette
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              sessions={resumeSessions}
              loading={resumeSessionsLoading}
              onRefresh={requestResumeSessions}
              onResumeSession={handleResumeFromHistory}
              nextCursor={resumeSessionsNextCursor}
              onLoadMore={() => { if (resumeSessionsNextCursor) requestResumeSessions(resumeSessionsNextCursor); }}
            />
          </Suspense>
        )}

        {newSessionMounted && (
          <Suspense fallback={<PanelFallback label="New session" />}>
            <LazyNewSessionWizardDialog
              open={newSessionOpen}
              onOpenChange={(open) => { if (lifecycleState.phase !== "spawning" && lifecycleState.phase !== "registering") setNewSessionOpen(open); }}
              runners={feedRunners.map((r) => ({ ...r, name: r.name ?? null, isOnline: true, sessionCount: liveSessions.filter(s => s.runnerId === r.runnerId).length }))}
              runnersLoading={runnersStatus === "connecting"}
              preselectedRunnerId={lifecycleState.spawn.preselectedRunnerId}
              initialCwd={lifecycleState.spawn.cwd}
              onSpawn={handleWizardSpawn}
            />
          </Suspense>
        )}

        {showPreferences && (
          <Suspense fallback={<PanelFallback label="Settings" />}>
            <LazyUserPreferencesPanel
              onClose={() => setShowPreferences(false)}
              onShowHiddenModels={() => setHiddenModelsOpen(true)}
              hiddenModelCount={availableModels.filter(m => hiddenModels.has(modelKey(m.provider, m.id))).length}
            />
          </Suspense>
        )}

        {showApiKeys && (
          <ApiKeysSheet
            apiKeyVersion={apiKeyVersion}
            onKeysChanged={() => setApiKeyVersion((v) => v + 1)}
            onClose={() => setShowApiKeys(false)}
          />
        )}

        {shortcutsMounted && (
          <Suspense fallback={<PanelFallback label="Shortcuts" />}>
            <LazyShortcutsDialog open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp} />
          </Suspense>
        )}

        <Dialog open={setupClaimOpen} onOpenChange={setSetupClaimOpen}>
          <DialogContent className="max-w-md p-0 overflow-hidden">
            <Suspense fallback={<PanelFallback label="Device setup" />}>
              <LazyDeviceSetupScanner
                initialToken={setupClaimToken ?? undefined}
                onClose={() => setSetupClaimOpen(false)}
              />
            </Suspense>
          </DialogContent>
        </Dialog>

        <ToastStack toasts={toasts} onDismiss={dismissToast} />

        <FrontendLogOverlay />
      </div>
    </div>
    </TooltipProvider>
    </ViewerSocketContext.Provider>
    </HubSocketContext.Provider>
    </ThemeProvider>
  );
}
