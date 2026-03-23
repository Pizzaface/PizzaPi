import * as React from "react";
import { initAnimationSync } from "@/lib/synced-animation";
import { SessionSidebar, type DotState, type HubSession } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import type { CommandResultData } from "@/components/session-viewer/rendering";
import { detectInFlightTools } from "@/components/session-viewer/utils";
import { DesktopHeader, MobileHeader } from "@/components/AppHeaders";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { RunnerTokenManager } from "@/components/RunnerTokenManager";
import { RunnerManager } from "@/components/RunnerManager";
import { NewSessionWizardDialog } from "@/components/NewSessionWizardDialog";
import { authClient, useSession, type BetterAuthSession } from "@/lib/auth-client";
import { useRunnersFeed } from "@/lib/useRunnersFeed";
import { io, type Socket } from "socket.io-client";
import type {
  ViewerServerToClientEvents,
  ViewerClientToServerEvents,
  HubServerToClientEvents,
  HubClientToServerEvents,
  SessionMetaState,
} from "@pizzapi/protocol";
import { isMetaRelayEvent, SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { cn } from "@/lib/utils";
import { pulseStreamingHaptic, cancelHaptic, startToolHaptic, stopToolHaptic } from "@/lib/haptics";
import { shouldCenterTopSpanFullWidth, shouldCenterBottomSpanFullWidth } from "@/utils/panelLayoutHelpers";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { X, TerminalIcon, FolderTree, GitBranch, EyeOff, Zap } from "lucide-react";
import { TriggersPanel } from "@/components/TriggersPanel";
import type { ProviderUsageMap } from "@/components/UsageIndicator";
import { TerminalManager } from "@/components/TerminalManager";
import { FileExplorer } from "@/components/FileExplorer";
import { GitPanel } from "@/components/git";
import { CombinedPanel, type CombinedPanelTab } from "@/components/CombinedPanel";
import { DockedPanelGroup, TAB_BAR_HEIGHT } from "@/components/DockedPanelGroup";
import { ViewerSocketContext } from "@/lib/viewer-socket-context";
import { HubSocketContext } from "@/lib/hub-socket-context";
import { shouldStopViewerReconnect } from "@/lib/viewer-connection";
import { mapUserError } from "@/lib/user-error-message";
import { getConfirmedMetaSubscriptionTargets } from "@/lib/meta-subscriptions";
import { evaluateVersionNegotiation } from "@/lib/version-negotiation";
import { useRunnerServices, attachServiceAnnounceListener, seedServiceCache, setViewerSwitchGeneration } from "@/hooks/useRunnerServices";
import { ServicePanelButtons, useServicePanelState } from "@/components/service-panels/ServicePanels";
import { SERVICE_PANELS } from "@/components/service-panels/registry";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { resolveNewPanelPosition, resolveActiveTabIdFromIds } from "@/utils/servicePanelUtils";
import { IframeServicePanel } from "@/components/service-panels/IframeServicePanel";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorShortcut,
} from "@/components/ai-elements/model-selector";
import { HiddenModelsManager, loadHiddenModels, fetchHiddenModels, modelKey } from "@/components/HiddenModelsManager";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { DegradedBanner } from "@/components/DegradedBanner";
import { RunnerWarningBanner } from "@/components/RunnerWarningBanner";
import { VersionBanner } from "@/components/VersionBanner";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import {
  beginInputAttempt,
  completeInputAttempt,
  failInputAttempt,
  shouldDeduplicateInput,
  type InputDedupeState,
} from "@/lib/input-dedupe";
import { parsePendingQuestionDisplayMode, parsePendingQuestions, type QuestionDisplayMode, type QuestionType } from "@/lib/ask-user-questions";
import type { TodoItem, TokenUsage, ConfiguredModelInfo, ResumeSessionOption, QueuedMessage, SessionUiCacheEntry } from "@/lib/types";
import { metaEventToStatePatch, type MetaStatePatch } from "@/lib/meta-state-apply";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { useTriggerCount } from "@/hooks/useTriggerCount";
import { useMobileSidebar } from "@/hooks/useMobileSidebar";
import {
  toRelayMessage,
  deduplicateMessages,
  normalizeMessages,
  normalizeModel,
  normalizeSessionName,
  augmentThinkingDurations,
  normalizeModelList,
  mergeChunkSnapshot,
} from "@/lib/message-helpers";
import { evictLruIfNeeded, touchSessionCache, MAX_SESSION_UI_CACHE_SIZE } from "@/lib/session-ui-cache";
import {
  analyzeIncomingSeq,
  canFinalizeChunkHydration,
  mergeConnectedSeq,
  registerChunkIndex,
  shouldDeferEventForHydration,
} from "@/lib/session-seq";
import { createLogger } from "@pizzapi/tools";
import { isActiveViewerSessionPayload, matchesViewerGeneration } from "@/lib/viewer-switch";

const log = createLogger("relay");

// Sync all CSS animations (pulse, chase-spin, etc.) to the same phase globally.
initAnimationSync();

declare const __PIZZAPI_UI_VERSION__: string;
const UI_VERSION = typeof __PIZZAPI_UI_VERSION__ === "string" && __PIZZAPI_UI_VERSION__.trim()
  ? __PIZZAPI_UI_VERSION__.trim()
  : "0.0.0";

declare const __PIZZAPI_BUILD_TIMESTAMP__: string;
const BUILD_TIMESTAMP =
  typeof __PIZZAPI_BUILD_TIMESTAMP__ === "string" && __PIZZAPI_BUILD_TIMESTAMP__.trim()
    ? __PIZZAPI_BUILD_TIMESTAMP__.trim()
    : null;

// ─── Session-scoped state ─────────────────────────────────────────────────────
// All fields below are reset atomically by clearSelection(). Adding new
// session-scoped state here ensures it is automatically included in the reset
// — nothing can be accidentally left stale when switching sessions.
interface SessionState {
  viewerSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null;
  activeSessionId: string | null;
  messages: RelayMessage[];
  viewerStatus: string;
  retryState: { errorMessage: string; detectedAt: number } | null;
  pendingQuestion: { toolCallId: string; questions: Array<{ question: string; options: string[]; type?: QuestionType }>; display: QuestionDisplayMode } | null;
  pendingPlan: { toolCallId: string; title: string; description: string | null; steps: Array<{ title: string; description?: string }> } | null;
  pluginTrustPrompt: { promptId: string; pluginNames: string[]; pluginSummaries: string[] } | null;
  activeToolCalls: Map<string, string>;
  mcpOAuthPastes: Array<{ serverName: string; authUrl: string; nonce: string; ts: number }>;
  messageQueue: QueuedMessage[];
  activeModel: ConfiguredModelInfo | null;
  sessionName: string | null;
  availableModels: ConfiguredModelInfo[];
  modelSelectorOpen: boolean;
  isChangingModel: boolean;
  agentActive: boolean;
  effortLevel: string | null;
  authSource: string | null;
  tokenUsage: TokenUsage | null;
  providerUsage: ProviderUsageMap | null;
  usageRefreshing: boolean;
  lastHeartbeatAt: number | null;
  availableCommands: Array<{ name: string; description?: string; source?: string }>;
  resumeSessions: ResumeSessionOption[];
  resumeSessionsLoading: boolean;
  pendingPermission: { requestId: string; toolName: string; toolInput: unknown; ts: number } | null;
  workerType: string;
}

function createInitialSessionState(): SessionState {
  return {
    viewerSocket: null,
    activeSessionId: null,
    messages: [],
    viewerStatus: "Idle",
    retryState: null,
    pendingQuestion: null,
    pendingPlan: null,
    pluginTrustPrompt: null,
    activeToolCalls: new Map(),
    mcpOAuthPastes: [],
    messageQueue: [],
    activeModel: null,
    sessionName: null,
    availableModels: [],
    modelSelectorOpen: false,
    isChangingModel: false,
    agentActive: false,
    effortLevel: null,
    authSource: null,
    tokenUsage: null,
    providerUsage: null,
    usageRefreshing: false,
    lastHeartbeatAt: null,
    availableCommands: [],
    resumeSessions: [],
    resumeSessionsLoading: false,
    pendingPermission: null,
    workerType: "pi",
  };
}
// ─────────────────────────────────────────────────────────────────────────────

export function App() {
  const { data: session, isPending } = useSession();
  const { runners: feedRunners, status: runnersStatus } = useRunnersFeed({
    // Only connect when auth is confirmed; reconnect if the user changes (e.g. logout → new login)
    enabled: !isPending && !!session?.user?.id,
    userId: session?.user?.id ?? undefined,
  });
  const [isDark, setIsDark] = React.useState(() => {
    const saved = localStorage.getItem("theme");
    return saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  // ─── Consolidated session state ─────────────────────────────────────────────
  // clearSelection() resets this entire object in a single atomic call.
  const [sessionState, setSessionState] = React.useState<SessionState>(createInitialSessionState);
  const {
    viewerSocket, activeSessionId, messages, viewerStatus, retryState,
    pendingQuestion, pendingPlan, pluginTrustPrompt, activeToolCalls,
    mcpOAuthPastes, messageQueue, activeModel, sessionName, availableModels,
    modelSelectorOpen, isChangingModel, agentActive, effortLevel, authSource,
    tokenUsage, providerUsage, usageRefreshing, lastHeartbeatAt,
    availableCommands, resumeSessions, resumeSessionsLoading,
    pendingPermission, workerType,
  } = sessionState;

  // Thin setter wrappers — identical signatures to the original useState setters
  // so all existing call-sites compile unchanged. Each supports both direct
  // values and functional updates (React.SetStateAction<T>).
  const setViewerSocket = React.useCallback(
    (v: React.SetStateAction<SessionState["viewerSocket"]>) =>
      setSessionState((p: SessionState) => ({ ...p, viewerSocket: typeof v === "function" ? v(p.viewerSocket) : v })),
    []
  );
  const setActiveSessionId = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, activeSessionId: typeof v === "function" ? v(p.activeSessionId) : v })),
    []
  );
  const setMessages = React.useCallback(
    (v: React.SetStateAction<RelayMessage[]>) =>
      setSessionState((p: SessionState) => ({ ...p, messages: typeof v === "function" ? v(p.messages) : v })),
    []
  );
  const setViewerStatus = React.useCallback(
    (v: React.SetStateAction<string>) =>
      setSessionState((p: SessionState) => ({ ...p, viewerStatus: typeof v === "function" ? v(p.viewerStatus) : v })),
    []
  );
  const setRetryState = React.useCallback(
    (v: React.SetStateAction<SessionState["retryState"]>) =>
      setSessionState((p: SessionState) => ({ ...p, retryState: typeof v === "function" ? v(p.retryState) : v })),
    []
  );
  const setPendingQuestion = React.useCallback(
    (v: React.SetStateAction<SessionState["pendingQuestion"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pendingQuestion: typeof v === "function" ? v(p.pendingQuestion) : v })),
    []
  );
  const setPendingPlan = React.useCallback(
    (v: React.SetStateAction<SessionState["pendingPlan"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pendingPlan: typeof v === "function" ? v(p.pendingPlan) : v })),
    []
  );
  const setPluginTrustPrompt = React.useCallback(
    (v: React.SetStateAction<SessionState["pluginTrustPrompt"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pluginTrustPrompt: typeof v === "function" ? v(p.pluginTrustPrompt) : v })),
    []
  );
  const setActiveToolCalls = React.useCallback(
    (v: React.SetStateAction<Map<string, string>>) =>
      setSessionState((p: SessionState) => ({ ...p, activeToolCalls: typeof v === "function" ? v(p.activeToolCalls) : v })),
    []
  );
  const setMcpOAuthPastes = React.useCallback(
    (v: React.SetStateAction<SessionState["mcpOAuthPastes"]>) =>
      setSessionState((p: SessionState) => ({ ...p, mcpOAuthPastes: typeof v === "function" ? v(p.mcpOAuthPastes) : v })),
    []
  );
  const setMessageQueue = React.useCallback(
    (v: React.SetStateAction<QueuedMessage[]>) =>
      setSessionState((p: SessionState) => ({ ...p, messageQueue: typeof v === "function" ? v(p.messageQueue) : v })),
    []
  );
  const setActiveModel = React.useCallback(
    (v: React.SetStateAction<ConfiguredModelInfo | null>) =>
      setSessionState((p: SessionState) => ({ ...p, activeModel: typeof v === "function" ? v(p.activeModel) : v })),
    []
  );
  const setSessionName = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, sessionName: typeof v === "function" ? v(p.sessionName) : v })),
    []
  );
  const setAvailableModels = React.useCallback(
    (v: React.SetStateAction<ConfiguredModelInfo[]>) =>
      setSessionState((p: SessionState) => ({ ...p, availableModels: typeof v === "function" ? v(p.availableModels) : v })),
    []
  );
  const setModelSelectorOpen = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, modelSelectorOpen: typeof v === "function" ? v(p.modelSelectorOpen) : v })),
    []
  );
  const setIsChangingModel = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, isChangingModel: typeof v === "function" ? v(p.isChangingModel) : v })),
    []
  );
  const setAgentActive = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, agentActive: typeof v === "function" ? v(p.agentActive) : v })),
    []
  );
  const setEffortLevel = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, effortLevel: typeof v === "function" ? v(p.effortLevel) : v })),
    []
  );
  const setAuthSource = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, authSource: typeof v === "function" ? v(p.authSource) : v })),
    []
  );
  const setTokenUsage = React.useCallback(
    (v: React.SetStateAction<TokenUsage | null>) =>
      setSessionState((p: SessionState) => ({ ...p, tokenUsage: typeof v === "function" ? v(p.tokenUsage) : v })),
    []
  );
  const setProviderUsage = React.useCallback(
    (v: React.SetStateAction<ProviderUsageMap | null>) =>
      setSessionState((p: SessionState) => ({ ...p, providerUsage: typeof v === "function" ? v(p.providerUsage) : v })),
    []
  );
  const setUsageRefreshing = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, usageRefreshing: typeof v === "function" ? v(p.usageRefreshing) : v })),
    []
  );
  const setLastHeartbeatAt = React.useCallback(
    (v: React.SetStateAction<number | null>) =>
      setSessionState((p: SessionState) => ({ ...p, lastHeartbeatAt: typeof v === "function" ? v(p.lastHeartbeatAt) : v })),
    []
  );
  const setAvailableCommands = React.useCallback(
    (v: React.SetStateAction<Array<{ name: string; description?: string; source?: string }>>) =>
      setSessionState((p: SessionState) => ({ ...p, availableCommands: typeof v === "function" ? v(p.availableCommands) : v })),
    []
  );
  const setResumeSessions = React.useCallback(
    (v: React.SetStateAction<ResumeSessionOption[]>) =>
      setSessionState((p: SessionState) => ({ ...p, resumeSessions: typeof v === "function" ? v(p.resumeSessions) : v })),
    []
  );
  const setResumeSessionsLoading = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, resumeSessionsLoading: typeof v === "function" ? v(p.resumeSessionsLoading) : v })),
    []
  );
  const setPendingPermission = React.useCallback(
    (v: React.SetStateAction<SessionState["pendingPermission"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pendingPermission: typeof v === "function" ? v(p.pendingPermission) : v })),
    []
  );
  const setWorkerType = React.useCallback(
    (v: React.SetStateAction<string>) =>
      setSessionState((p: SessionState) => ({ ...p, workerType: typeof v === "function" ? v(p.workerType) : v })),
    []
  );
  // ────────────────────────────────────────────────────────────────────────────
  // Ref kept in sync with `messages` via useLayoutEffect so we can read the
  // latest committed value in event handlers without needing functional updaters.
  // This lets us move patchSessionCache side effects OUT of setMessages updaters,
  // which would otherwise be called speculatively in React concurrent mode.
  const messagesRef = React.useRef<RelayMessage[]>(messages);
  React.useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  const [relayStatus, setRelayStatus] = React.useState<DotState>("connecting");
  const [versionBanner, setVersionBanner] = React.useState<{ message: string | null; protocolCompatible: boolean }>({
    message: null,
    protocolCompatible: true,
  });
  const [showApiKeys, setShowApiKeys] = React.useState(false);
  const [apiKeyVersion, setApiKeyVersion] = React.useState(0);
  const [showRunners, setShowRunners] = React.useState(false);
  const [selectedRunnerId, setSelectedRunnerId] = React.useState<string | null>(null);
  const [runnersForSidebar, setRunnersForSidebar] = React.useState<Array<{
    runnerId: string;
    name: string | null;
    sessionCount: number;
    version: string | null;
    isOnline: boolean;
  }>>([]);
  // User-scoped cache key for sidebar runners (prevents cross-account data leakage)
  const sidebarCacheKey = React.useMemo(() => {
    const userId = (session as BetterAuthSession | null)?.user?.id ?? null;
    return userId ? `pp-sidebar-runners:${userId}` : null;
  }, [session]);
  // Hydrate from cache once we know the user
  React.useEffect(() => {
    if (!sidebarCacheKey) return;
    try {
      const cached = sessionStorage.getItem(sidebarCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) setRunnersForSidebar(parsed);
      }
    } catch { /* ignore */ }
    // Clean up legacy unscoped key
    try { sessionStorage.removeItem("pp-sidebar-runners"); } catch { /* ignore */ }
  }, [sidebarCacheKey]);
  // Write-through: persist sidebar runners to sessionStorage on every update
  const setSidebarRunners = React.useCallback((runners: typeof runnersForSidebar) => {
    setRunnersForSidebar(runners);
    if (sidebarCacheKey) {
      try { sessionStorage.setItem(sidebarCacheKey, JSON.stringify(runners)); } catch { /* ignore */ }
    }
  }, [sidebarCacheKey]);
  const panelLayout = usePanelLayout(activeSessionId);
  const {
    showTerminal, setShowTerminal,
    terminalPosition,
    terminalColumnRef,
    handleTerminalPositionChange,
    panelDragActive, panelDragZone,
    startPanelDragWith,
    handleOuterPointerMove, handleOuterPointerUp,
    combinedActiveTab, handleCombinedTabChange,
    terminalTabs, activeTerminalId, setActiveTerminalId,
    handleTerminalTabAdd, handleTerminalTabClose,
    showFileExplorer, setShowFileExplorer,
    filesPosition,
    handleFilesPositionChange,
    showGit, setShowGit,
    gitPosition, handleGitPositionChange,
    leftColumnWidth, rightColumnWidth,
    leftTopHeight, leftBottomHeight,
    rightTopHeight, rightBottomHeight,
    centerTopHeight, centerBottomHeight,
    startColumnWidthResize, startZoneHeightResize,
    showTriggers, setShowTriggers,
    triggersPosition, handleTriggersPositionChange,
  } = panelLayout;

  const [newSessionOpen, setNewSessionOpen] = React.useState(false);
  const [spawnRunnerId, setSpawnRunnerId] = React.useState<string | undefined>(undefined);
  const [spawnWorkerType, setSpawnWorkerType] = React.useState<"pi" | "claude-code">("pi");
  const [spawnCwd, setSpawnCwd] = React.useState<string>("");
  const [spawnPreselectedRunnerId, setSpawnPreselectedRunnerId] = React.useState<string | null>(null);
  const [spawningSession, setSpawningSession] = React.useState(false);
  const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
  const [recentFoldersLoading, setRecentFoldersLoading] = React.useState(false);

  /** Set of session IDs that currently have a pending AskUserQuestion. */
  const [sessionsAwaitingInput, setSessionsAwaitingInput] = React.useState<Set<string>>(new Set());

  /** Set of session IDs that are actively compacting their context window. */
  const [sessionsCompacting, setSessionsCompacting] = React.useState<Set<string>>(new Set());


  // Cached fallback promptKey for when toolCallId is absent (legacy/compat).
  // Only changes when the question content changes, preventing heartbeat
  // re-applications from resetting the MC component's selection state.
  // Stable fallback promptKey: only changes when question content changes.
  const pendingQuestionFallbackRef = React.useRef<{ fingerprint: string; key: string }>({ fingerprint: "", key: "" });
  const pendingQuestionSeqRef = React.useRef(0);
  /** Return a stable fallback key for a set of parsed questions (used when toolCallId is absent). */
  const getFallbackPromptKey = React.useCallback((questions: Array<{ question: string; options: string[] }>): string => {
    const fp = JSON.stringify(questions);
    if (pendingQuestionFallbackRef.current.fingerprint !== fp) {
      pendingQuestionFallbackRef.current = {
        fingerprint: fp,
        key: `ask-user-question-${++pendingQuestionSeqRef.current}`,
      };
    }
    return pendingQuestionFallbackRef.current.key;
  }, []);
  const [hiddenModels, setHiddenModels] = React.useState<Set<string>>(() => loadHiddenModels());
  const [hiddenModelsOpen, setHiddenModelsOpen] = React.useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = React.useState(false);

  // Live session status from heartbeats (isCompacting and planModeEnabled are intentionally
  // NOT part of SessionState because they are not reset by clearSelection)
  const [isCompacting, setIsCompacting] = React.useState(false);
  const [planModeEnabled, setPlanModeEnabled] = React.useState(false);
  const [todoList, setTodoList] = React.useState<TodoItem[]>([]);


  // Keyboard shortcuts
  const isMac = React.useMemo(() => {
    const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
    return /Mac|iPhone|iPad/i.test(platform);
  }, []);
  const [showShortcutsHelp, setShowShortcutsHelp] = React.useState(false);

  // Sequence tracking for gap detection
  const lastSeqRef = React.useRef<number | null>(null);

  // Stale-connection detection: track the last time any event arrived from the relay.
  // If the socket believes it's connected but nothing has arrived for STALE_THRESHOLD_MS
  // (NAT timeout, middlebox drop, background tab, etc.) we force-reconnect.
  const lastViewerEventAtRef = React.useRef<number>(0);
  const staleCheckTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const STALE_THRESHOLD_MS = 45_000; // ~4.5 × 10s heartbeat interval
  const STALE_CHECK_INTERVAL_MS = 15_000;

  // Snapshot guard: when connecting to a session, ignore streaming deltas
  // until the initial snapshot (session_active / agent_end / heartbeat) arrives.
  // This prevents pre-snapshot live events from rendering and then being
  // replaced, which causes visible message "jumping".
  const awaitingSnapshotRef = React.useRef(false);

  // Track which MCP startup report timestamps have already been rendered
  // to avoid duplicates when heartbeats re-deliver the same report.
  const renderedMcpReportTsRef = React.useRef<number | null>(null);

  // Whether session_active has been received for the current session.
  // Heartbeat MCP reports are deferred until after session_active hydrates
  // messages, otherwise the report gets appended then immediately replaced.
  const sessionHydratedRef = React.useRef(false);

  // Holds an MCP startup report that arrived (via hub state_snapshot) before
  // session_active hydration completed. Flushed when hydration finishes.
  // Needed for the new slim-heartbeat CLI that no longer retries in every heartbeat.
  const pendingMcpReportRef = React.useRef<Record<string, unknown> | null>(null);

  // Locally-injected messages (e.g. MCP auth banners) that must survive
  // wholesale setMessages replacements from session_active / agent_end.
  const injectedMessagesRef = React.useRef<RelayMessage[]>([]);

  // Tracks the highest meta state version seen per session, to prevent stale
  // state_snapshot from rolling back state already updated by meta_event.
  const metaVersionsRef = React.useRef<Map<string, number>>(new Map());

  // Tracks which session's meta room we've joined so we can unsubscribe when needed.
  const prevMetaSessionRef = React.useRef<string | null>(null);
  const confirmedMetaLiveSessionIdsRef = React.useRef<Set<string>>(new Set());
  const [metaInventoryVersion, setMetaInventoryVersion] = React.useState(0);

  // Chunked session delivery: when session_active arrives with chunked:true,
  // messages follow as session_messages_chunk events. This ref tracks state.
  // The snapshotId ties chunks to their originating session_active so stale
  // chunks from a previous stream are discarded (e.g. if a new viewer
  // connects mid-stream and triggers a fresh emitSessionActive).
  const chunkedDeliveryRef = React.useRef<{
    snapshotId: string;
    totalMessages: number;
    totalChunks: number;
    receivedChunkIndexes: Set<number>;
    finalChunkSeen: boolean;
    loadedMessages: number; // cumulative count for progress display
    chunkBuffer: Map<number, unknown[]>; // raw messages buffered by chunkIndex for ordered assembly
  } | null>(null);

  // Track the last completed snapshot ID so we can reject stale chunks that
  // arrive after the ref has been cleared (e.g. from a superseded sender).
  const lastCompletedSnapshotRef = React.useRef<string | null>(null);

  // Mobile layout
  const {
    sidebarOpen, setSidebarOpen,
    sidebarSwipeOffset, suppressOverlayClickRef,
    handleSidebarPointerDown, handleSidebarPointerMove, handleSidebarPointerUp,
  } = useMobileSidebar();
  const [liveSessions, setLiveSessions] = React.useState<HubSession[]>([]);
  // Ref kept in sync with liveSessions so openSession can look up runner IDs
  // without including liveSessions in its dependency array.
  const liveSessionsRef = React.useRef<HubSession[]>(liveSessions);
  React.useLayoutEffect(() => { liveSessionsRef.current = liveSessions; }, [liveSessions]);

  React.useEffect(() => {
    confirmedMetaLiveSessionIdsRef.current = new Set(liveSessions.map((s) => s.sessionId));
    setMetaInventoryVersion((version) => version + 1);
  }, [liveSessions]);

  // Derive sidebar runners from the /runners WS feed
  React.useEffect(() => {
    setSidebarRunners(feedRunners.map(r => ({
      runnerId: r.runnerId,
      name: r.name,
      sessionCount: liveSessions.filter(s => s.runnerId === r.runnerId).length,
      version: r.version,
      isOnline: true,
    })));
  }, [feedRunners, liveSessions, setSidebarRunners]);

  const [sessionSwitcherOpen, setSessionSwitcherOpen] = React.useState(false);

  // Auto-reopen the last viewed session once live sessions arrive.
  // (restoredRef is declared here; the effect is placed after openSession is defined below)
  const restoredRef = React.useRef(false);

  // Deep-link: if the page was loaded with a /session/<id> URL, capture the
  // session ID on mount so we can open it once auth + liveSessions are ready.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deepLinkSessionIdRef = React.useRef<string | null>(
    (() => {
      const m = window.location.pathname.match(/^\/session\/([^/]+)(?:\/|$)/);
      return m ? decodeURIComponent(m[1]) : null;
    })(),
  );

  // Tracks a session that was restarted via the remote exec "restart" command.
  // When the session comes back live (hub sends session_added), we auto-reconnect.
  const restartPendingSessionIdRef = React.useRef<string | null>(null);
  const restartPendingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);



  // Fetch recent folders when a runner is selected in the new-session dialog.
  React.useEffect(() => {
    if (!newSessionOpen || !spawnRunnerId) {
      setRecentFolders([]);
      return;
    }

    let cancelled = false;
    setRecentFoldersLoading(true);
    void fetch(`/api/runners/${encodeURIComponent(spawnRunnerId)}/recent-folders`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray((data as any)?.folders) ? (data as any).folders as string[] : [];
        setRecentFolders(list);
      })
      .catch(() => {
        if (cancelled) return;
        setRecentFolders([]);
      })
      .finally(() => {
        if (cancelled) return;
        setRecentFoldersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [newSessionOpen, spawnRunnerId]);

  const viewerWsRef = React.useRef<Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null>(null);
  // viewerSocket is part of SessionState — tracked so ViewerSocketContext consumers re-render.
  const hubSocketRef = React.useRef<Socket<HubServerToClientEvents, HubClientToServerEvents> | null>(null);
  // Tracked as state so HubSocketContext consumers re-render when the socket changes.
  const [hubSocket, setHubSocket] = React.useState<Socket<HubServerToClientEvents, HubClientToServerEvents> | null>(null);
  const activeSessionRef = React.useRef<string | null>(null);
  const viewerSwitchGenerationRef = React.useRef(0);

  const checkVersionCompatibility = React.useCallback(async () => {
    try {
      const res = await fetch("/health", { credentials: "include" });
      if (!res.ok) return;
      const payload: unknown = await res.json();
      const negotiation = evaluateVersionNegotiation(payload, {
        uiVersion: UI_VERSION,
        clientSocketProtocol: SOCKET_PROTOCOL_VERSION,
        uiBuildTimestamp: BUILD_TIMESTAMP,
      });
      setVersionBanner({
        message: negotiation.message,
        protocolCompatible: negotiation.protocolCompatible,
      });
    } catch {
      // Best effort only — do not surface transient fetch errors as hard failures.
    }
  }, []);

  // Cache last-known UI state per relay session so switching sessions feels instant.
  const sessionUiCacheRef = React.useRef<Map<string, SessionUiCacheEntry>>(new Map());

  const patchSessionCache = React.useCallback((patch: Partial<SessionUiCacheEntry>) => {
    const sessionId = activeSessionRef.current;
    if (!sessionId) return;

    const prev = sessionUiCacheRef.current.get(sessionId);
    const next: SessionUiCacheEntry = {
      messages: prev?.messages ?? [],
      activeModel: prev?.activeModel ?? null,
      sessionName: prev?.sessionName ?? null,
      availableModels: prev?.availableModels ?? [],
      availableCommands: prev?.availableCommands ?? [],
      agentActive: prev?.agentActive ?? false,
      isCompacting: prev?.isCompacting ?? false,
      effortLevel: prev?.effortLevel ?? null,
      planModeEnabled: prev?.planModeEnabled ?? false,
      authSource: prev?.authSource ?? null,
      tokenUsage: prev?.tokenUsage ?? null,
      providerUsage: prev?.providerUsage ?? null,
      lastHeartbeatAt: prev?.lastHeartbeatAt ?? null,
      todoList: prev?.todoList ?? [],
      pendingQuestion: prev?.pendingQuestion ?? null,
      pendingPlan: prev?.pendingPlan ?? null,
      workerType: prev?.workerType ?? "pi",
      ...patch,
      lastAccessed: Date.now(),
    };

    // Evict the least-recently-accessed entry if we're over the size limit.
    evictLruIfNeeded(sessionUiCacheRef.current, sessionId, MAX_SESSION_UI_CACHE_SIZE, activeSessionRef.current);

    sessionUiCacheRef.current.set(sessionId, next);

    // Keep the sidebar indicator in sync: track which sessions are awaiting input
    // (either a pending question or a pending plan review).
    if (Object.prototype.hasOwnProperty.call(patch, "pendingQuestion") ||
        Object.prototype.hasOwnProperty.call(patch, "pendingPlan")) {
      setSessionsAwaitingInput((prev) => {
        const next = new Set(prev);
        if (patch.pendingQuestion || patch.pendingPlan) {
          next.add(sessionId);
        } else if (!patch.pendingQuestion && !patch.pendingPlan) {
          next.delete(sessionId);
        }
        return next;
      });
    }
  }, [setSessionsAwaitingInput]);

  // Debounce streaming delta updates (toolcall_delta, text_delta, thinking_delta) so we
  // flush at most once per animation frame instead of once per character.
  const pendingDeltaRef = React.useRef<Map<string, { raw: unknown; key: string }>>(new Map());
  const deltaRafRef = React.useRef<number | null>(null);
  // Key of the in-flight streaming partial message; evicted when the final message lands.
  const streamingPartialKeyRef = React.useRef<string | null>(null);

  // Separate RAF-based debounce for tool_execution_update streaming (e.g. bash
  // output). Kept independent of the assistant delta debounce above to avoid
  // interference with streamingPartialKeyRef / evictPartial logic.
  const pendingToolStreamRef = React.useRef<Map<string, unknown>>(new Map());
  const toolStreamRafRef = React.useRef<number | null>(null);

  // Track wall-clock timing of thinking blocks so we can bake duration into the content.
  // contentIndex → Date.now() at thinking_start
  const thinkingStartTimesRef = React.useRef<Map<number, number>>(new Map());
  // contentIndex → elapsed seconds at thinking_end
  const thinkingDurationsRef = React.useRef<Map<number, number>>(new Map());

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.setItem("theme", isDark ? "dark" : "light");
  }, [isDark]);

  // Fetch hidden models from server once authenticated — server is the
  // source of truth; localStorage is the fast-load cache.
  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void fetchHiddenModels().then((serverSet) => {
      if (cancelled) return;
      setHiddenModels(serverSet);
    });
    return () => { cancelled = true; };
  }, [session]);

  React.useEffect(() => {
    if (!session) return;
    void checkVersionCompatibility();
  }, [session, checkVersionCompatibility]);

  React.useEffect(() => {
    return () => {
      if (staleCheckTimerRef.current !== null) {
        clearInterval(staleCheckTimerRef.current);
        staleCheckTimerRef.current = null;
      }
      viewerWsRef.current?.disconnect();
      viewerWsRef.current = null;
      setViewerSocket(null);
    };
  }, []);

  const clearSelection = React.useCallback(() => {
    if (staleCheckTimerRef.current !== null) {
      clearInterval(staleCheckTimerRef.current);
      staleCheckTimerRef.current = null;
    }
    viewerWsRef.current?.disconnect();
    viewerWsRef.current = null;
    activeSessionRef.current = null;
    lastSeqRef.current = null;
    awaitingSnapshotRef.current = false;
    renderedMcpReportTsRef.current = null;
    injectedMessagesRef.current = [];
    // Single atomic reset — all session-scoped fields defined in SessionState
    // are cleared together. New fields added to SessionState are automatically
    // included; nothing can be accidentally left stale between sessions.
    setSessionState(createInitialSessionState());
    // Reset live-status fields that are intentionally outside SessionState
    // (they are driven by heartbeats, not snapshots) but must still be cleared
    // when switching sessions so stale "compacting" / "plan mode" indicators
    // are not carried over until the next heartbeat arrives.
    setIsCompacting(false);
    setPlanModeEnabled(false);
  }, []);

  // Full reset: cancel the RAF and wipe all pending streaming state. Use before
  // replacing the entire message list (session_active, agent_end) so a queued
  // RAF can't staple a stale partial on top of the fresh snapshot.
  const cancelPendingDeltas = React.useCallback(() => {
    if (deltaRafRef.current !== null) {
      cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    pendingDeltaRef.current = new Map();
    streamingPartialKeyRef.current = null;
    thinkingStartTimesRef.current = new Map();
    thinkingDurationsRef.current = new Map();
    if (toolStreamRafRef.current !== null) {
      cancelAnimationFrame(toolStreamRafRef.current);
      toolStreamRafRef.current = null;
    }
    pendingToolStreamRef.current = new Map();
  }, []);

  const upsertMessage = React.useCallback((raw: unknown, fallback: string, evictPartial = false) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    if (evictPartial && streamingPartialKeyRef.current) {
      // Remove only the partial from the pending queue so the RAF can't
      // re-insert it after we evict it from state. We intentionally do NOT
      // clear streamingPartialKeyRef here — the setMessages callback below
      // still needs it to locate and splice out the partial from state.
      pendingDeltaRef.current.delete(streamingPartialKeyRef.current);
      if (pendingDeltaRef.current.size === 0 && deltaRafRef.current !== null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
    }

    setMessages((prev) => {
      let base = prev;
      if (evictPartial && streamingPartialKeyRef.current && streamingPartialKeyRef.current !== next.key) {
        const partialIdx = base.findIndex((m) => m.key === streamingPartialKeyRef.current);
        if (partialIdx >= 0) {
          base = base.slice();
          base.splice(partialIdx, 1);
        }
        streamingPartialKeyRef.current = null;
      }
      const idx = base.findIndex((m) => m.key === next.key);
      if (idx >= 0) {
        const updated = base === prev ? base.slice() : base;
        updated[idx] = next;
        return updated;
      }

      // When a user message arrives from the server, check for a locally-inserted
      // steer message with the same content and replace it instead of appending a
      // duplicate. Steer messages are added optimistically with key "user:steer:*"
      // but the server echoes them back with a different key (e.g. "user:ts:*").
      if (next.role === "user") {
        const nextText = typeof next.content === "string"
          ? next.content.trim()
          : Array.isArray(next.content)
            ? (next.content as Array<Record<string, unknown>>)
                .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
                .map((b) => b.text as string)
                .join("")
                .trim()
            : "";
        if (nextText) {
          const steerIdx = base.findIndex((m) =>
            m.key.startsWith("user:steer:") &&
            m.role === "user" &&
            (typeof m.content === "string" ? m.content.trim() : "") === nextText,
          );
          if (steerIdx >= 0) {
            const updated = base === prev ? base.slice() : base;
            updated[steerIdx] = next;
            return updated;
          }
        }
      }

      return [...base, next];
    });
  }, []);

  const upsertMessageDebounced = React.useCallback((raw: unknown, fallback: string) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    streamingPartialKeyRef.current = next.key;
    pendingDeltaRef.current.set(next.key, { raw, key: next.key });

    if (deltaRafRef.current === null) {
      deltaRafRef.current = requestAnimationFrame(() => {
        deltaRafRef.current = null;
        const pending = pendingDeltaRef.current;
        pendingDeltaRef.current = new Map();
        setMessages((prev) => {
          let result = prev;
          let keyMap: Map<string, number> | null = null;

          for (const { raw: pendingRaw, key } of pending.values()) {
            let msg = toRelayMessage(pendingRaw, key);
            if (!msg) continue;

            // Lazily initialize the map of existing keys to indices to convert
            // O(N*M) lookups into O(N+M)
            if (keyMap === null) {
              keyMap = new Map();
              for (let i = 0; i < result.length; i++) {
                keyMap.set(result[i].key, i);
              }
            }

            // Try to find an existing message by key
            let idx = keyMap.get(msg.key) ?? -1;

            // Heuristic: if not found, and it's a fallback key (streaming),
            // and the last message is itself a no-timestamp streaming partial
            // from the current turn, adopt its key to update in-place.
            // We must NOT adopt completed (timestamped) messages — that would
            // overwrite a previous turn's finished reply with new streaming
            // content, causing it to appear before the user's latest message.
            if (idx === -1 && msg.key.includes(":fallback:")) {
              const lastIdx = result.length - 1;
              if (lastIdx >= 0) {
                const last = result[lastIdx];
                if (last.role === msg.role && !last.isError && last.timestamp === undefined) {
                  // Inherit the key from the existing partial so we update
                  // in-place rather than appending a second streaming bubble.
                  msg = { ...msg, key: last.key };
                  idx = lastIdx;
                }
              }
            }

            if (idx >= 0) {
              if (result === prev) result = prev.slice();
              result[idx] = msg;
            } else {
              if (result === prev) result = prev.slice();
              result.push(msg);
              keyMap.set(msg.key, result.length - 1); // keep map updated for subsequent pending items
            }
          }
          return result;
        });
      });
    }
  }, []);

  /**
   * Schedule a batched flush of pending tool_execution_update partials via RAF.
   * Each tool call accumulates its latest partial in pendingToolStreamRef, and
   * once per animation frame we upsert them into state as synthetic toolResult
   * messages so the UI renders live output (e.g. bash command streaming).
   */
  const scheduleToolStreamFlush = React.useCallback(() => {
    if (toolStreamRafRef.current !== null) return; // already scheduled
    toolStreamRafRef.current = requestAnimationFrame(() => {
      toolStreamRafRef.current = null;
      const pending = pendingToolStreamRef.current;
      if (pending.size === 0) return;
      pendingToolStreamRef.current = new Map();
      setMessages((prev) => {
        let result = prev;
        let keyMap: Map<string, number> | null = null;

        for (const [, raw] of pending) {
          const msg = toRelayMessage(raw, "tool-stream");
          if (!msg) continue;

          if (keyMap === null) {
            keyMap = new Map();
            for (let i = 0; i < result.length; i++) {
              keyMap.set(result[i].key, i);
            }
          }

          const idx = keyMap.get(msg.key) ?? -1;
          if (idx >= 0) {
            if (result === prev) result = prev.slice();
            result[idx] = msg;
          } else {
            if (result === prev) result = prev.slice();
            result.push(msg);
            keyMap.set(msg.key, result.length - 1); // keep map updated
          }
        }
        return result;
      });
    });
  }, []);

  const appendLocalSystemMessage = React.useCallback((content: string | CommandResultData) => {
    if (content === undefined || content === null) return;
    // For plain strings, trim and skip empties
    if (typeof content === "string" && !content.trim()) return;

    const now = Date.now();
    const message: RelayMessage = {
      key: `system:local:${now}:${Math.random().toString(16).slice(2)}`,
      role: "system",
      timestamp: now,
      content: typeof content === "string" ? content.trim() : content,
    };

    const next = [...messagesRef.current, message];
    setMessages(next);
    patchSessionCache({ messages: next });
  }, [patchSessionCache]);

  /** Remove a queued message whose text matches an incoming user message from the stream. */
  const removeQueuedMessageByContent = React.useCallback((rawMessage: unknown) => {
    if (!rawMessage || typeof rawMessage !== "object") return;
    const msg = rawMessage as Record<string, unknown>;
    if (msg.role !== "user") return;

    // Extract text from user message content (string or array of text blocks)
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<Record<string, unknown>>)
        .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
    }
    if (!text) return;

    const trimmed = text.trim();
    setMessageQueue((prev) => {
      if (prev.length === 0) return prev;
      // Find the first queued message whose text matches and remove it
      const idx = prev.findIndex((qm) => qm.text.trim() === trimmed);
      if (idx === -1) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
  }, []);

  const applyMcpReport = React.useCallback((mcpReport: {
    slow?: boolean;
    showSlowWarning?: boolean;
    errors?: Array<{ server: string; error: string }>;
    serverTimings?: Array<{ name: string; durationMs: number; toolCount: number; timedOut: boolean; error?: string }>;
    totalDurationMs?: number;
    ts?: number;
  }) => {
    const reportTs = typeof mcpReport.ts === "number" ? mcpReport.ts : 0;
    if (reportTs <= 0 || reportTs === renderedMcpReportTsRef.current || !sessionHydratedRef.current) return;
    const hasErrors = Array.isArray(mcpReport.errors) && mcpReport.errors.length > 0;
    const showSlow = mcpReport.showSlowWarning !== false;
    const isSlow = mcpReport.slow === true && showSlow;
    if (!hasErrors && !isSlow) return;
    renderedMcpReportTsRef.current = reportTs;
    const totalMs = typeof mcpReport.totalDurationMs === "number" ? mcpReport.totalDurationMs : 0;
    const totalDur = totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`;
    const parts: string[] = [];
    if (isSlow) parts.push(`⏱ MCP startup took ${totalDur}`);
    const timings = Array.isArray(mcpReport.serverTimings) ? mcpReport.serverTimings : [];
    const noteworthy = timings.filter((t) => t.error || t.timedOut || t.durationMs >= 3000);
    for (const t of noteworthy) {
      const dur = t.durationMs >= 1000 ? `${(t.durationMs / 1000).toFixed(1)}s` : `${t.durationMs}ms`;
      if (t.timedOut) parts.push(`  ⏱ ${t.name}: timed out (${dur})`);
      else if (t.error) parts.push(`  ✗ ${t.name}: ${t.error} (${dur})`);
      else parts.push(`  ● ${t.name}: ${dur}`);
    }
    if (hasErrors && !isSlow) {
      const errLines = mcpReport.errors!.map((e) => `  ✗ ${e.server}: ${e.error}`);
      parts.push(`⚠ MCP server errors:\n${errLines.join("\n")}`);
    }
    if (isSlow) parts.push("Tip: Use --safe-mode or --no-mcp for instant startup.");
    if (parts.length === 0) return;
    const message: RelayMessage = {
      key: `mcp_startup:${reportTs}:${Math.random().toString(16).slice(2)}`,
      role: "system",
      timestamp: reportTs,
      content: parts.join("\n"),
      isError: hasErrors,
    };
    // Use a functional updater so this chains correctly with any preceding
    // setMessages(prev => ...) call in the same React batch (e.g. the final
    // snapshot chunk updater).  Reading messagesRef.current here would be
    // stale because the ref is only synced after the React commit.
    let mcpNext: RelayMessage[] | null = null;
    setMessages((prev) => {
      if (prev.some((m) => m.key?.startsWith(`mcp_startup:${reportTs}`))) {
        return prev; // already appended — no change
      }
      mcpNext = [...prev, message];
      return mcpNext;
    });
    if (mcpNext !== null) {
      patchSessionCache({ messages: mcpNext });
    }
  }, [patchSessionCache]);

  const applyMetaStateSnapshot = React.useCallback((state: SessionMetaState) => {
    const cachePatch: Partial<SessionUiCacheEntry> = {};

    if (Array.isArray(state.todoList)) {
      setTodoList(state.todoList as TodoItem[]);
      cachePatch.todoList = state.todoList as TodoItem[];
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingQuestion")) {
      const pq = state.pendingQuestion;
      if (pq) {
        const questions = parsePendingQuestions(pq as unknown as Record<string, unknown>);
        if (questions.length > 0) {
          const resolved = {
            toolCallId: typeof pq.toolCallId === "string" ? pq.toolCallId : getFallbackPromptKey(questions),
            questions,
            display: parsePendingQuestionDisplayMode(pq as unknown as Record<string, unknown>, questions.length),
          };
          setPendingQuestion(resolved);
          cachePatch.pendingQuestion = resolved;
          setViewerStatus("Waiting for answer…");
        } else {
          setPendingQuestion(null);
          cachePatch.pendingQuestion = null;
        }
      } else {
        setPendingQuestion(null);
        cachePatch.pendingQuestion = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingPlan")) {
      const pp = state.pendingPlan;
      if (pp && typeof pp.toolCallId === "string" && typeof pp.title === "string" && pp.title.trim()) {
        const steps = Array.isArray(pp.steps)
          ? pp.steps.filter((s): s is { title: string; description?: string } =>
              s !== null && typeof s === "object" && typeof s.title === "string" && s.title.trim().length > 0,
            )
          : [];
        const resolved = {
          toolCallId: pp.toolCallId,
          title: pp.title.trim(),
          description: typeof pp.description === "string" && pp.description.trim() ? pp.description.trim() : null,
          steps,
        };
        setPendingPlan(resolved);
        cachePatch.pendingPlan = resolved;
        setViewerStatus("Waiting for plan review…");
      } else {
        setPendingPlan(null);
        cachePatch.pendingPlan = null;
      }
    }

    if (typeof state.planModeEnabled === "boolean") {
      setPlanModeEnabled(state.planModeEnabled);
      cachePatch.planModeEnabled = state.planModeEnabled;
    }

    if (typeof state.isCompacting === "boolean") {
      setIsCompacting(state.isCompacting);
      cachePatch.isCompacting = state.isCompacting;
      if (state.isCompacting) {
        setViewerStatus("Compacting…");
      }
      const snapSessionId = activeSessionRef.current;
      if (snapSessionId) {
        setSessionsCompacting((prev) => {
          const next = new Set(prev);
          if (state.isCompacting) { next.add(snapSessionId); } else { next.delete(snapSessionId); }
          return next;
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "retryState")) {
      setRetryState(state.retryState);
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingPluginTrust")) {
      const pt = state.pendingPluginTrust;
      if (pt && typeof pt.promptId === "string" && Array.isArray(pt.pluginNames) && pt.pluginNames.length > 0) {
        setPluginTrustPrompt({
          promptId: pt.promptId,
          pluginNames: pt.pluginNames,
          pluginSummaries: Array.isArray(pt.pluginSummaries) ? pt.pluginSummaries : pt.pluginNames,
        });
      } else {
        setPluginTrustPrompt(null);
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "tokenUsage")) {
      const usage = state.tokenUsage as TokenUsage | null;
      setTokenUsage(usage);
      cachePatch.tokenUsage = usage;
    }

    if (Object.prototype.hasOwnProperty.call(state, "providerUsage")) {
      const usage = state.providerUsage as ProviderUsageMap | null;
      setProviderUsage(usage);
      cachePatch.providerUsage = usage;
    }

    if (state.thinkingLevel !== undefined) {
      setEffortLevel(state.thinkingLevel);
      cachePatch.effortLevel = state.thinkingLevel;
    }

    if (state.authSource !== undefined) {
      setAuthSource(state.authSource);
      cachePatch.authSource = state.authSource;
    }

    if (state.model !== undefined) {
      if (state.model) {
        const m = normalizeModel(state.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      } else {
        // snapshot explicitly clears model
        setActiveModel(null);
        cachePatch.activeModel = null;
      }
    }

    // Apply mcpStartupReport from snapshot so late-joining viewers see MCP startup warnings.
    // If session is not yet hydrated, save it for replay once session_active arrives —
    // the new slim-heartbeat CLI no longer retries in every heartbeat, so without this
    // the report would be permanently lost for any viewer connecting to an existing session.
    if (state.mcpStartupReport) {
      if (sessionHydratedRef.current) {
        applyMcpReport(state.mcpStartupReport as Record<string, unknown>);
      } else {
        pendingMcpReportRef.current = state.mcpStartupReport as Record<string, unknown>;
      }
    }

    if (Object.keys(cachePatch).length > 0) {
      patchSessionCache(cachePatch);
    }
  }, [applyMcpReport, getFallbackPromptKey, patchSessionCache]);

  const applyMetaPatch = React.useCallback((patch: MetaStatePatch) => {
    const cachePatch: Partial<SessionUiCacheEntry> = {};

    if (patch.todoList !== undefined) {
      setTodoList(patch.todoList);
      cachePatch.todoList = patch.todoList;
    }

    if (patch.setPendingQuestion) {
      if (patch.pendingQuestion) {
        setPendingQuestion(patch.pendingQuestion);
        cachePatch.pendingQuestion = patch.pendingQuestion;
        setViewerStatus("Waiting for answer…");
      } else {
        setPendingQuestion(null);
        cachePatch.pendingQuestion = null;
      }
    }

    if (patch.setPendingPlan) {
      if (patch.pendingPlan) {
        const pp = patch.pendingPlan;
        if (pp && typeof pp.toolCallId === "string" && typeof pp.title === "string") {
          const steps = Array.isArray(pp.steps)
            ? pp.steps.filter((s): s is { title: string; description?: string } =>
                s !== null && typeof s === "object" && typeof (s as { title?: unknown }).title === "string" && (s as { title: string }).title.trim().length > 0,
              )
            : [];
          const resolved = {
            toolCallId: pp.toolCallId,
            title: pp.title.trim(),
            description: typeof pp.description === "string" && pp.description.trim() ? pp.description.trim() : null,
            steps,
          };
          setPendingPlan(resolved);
          cachePatch.pendingPlan = resolved;
          setViewerStatus("Waiting for plan review…");
        }
      } else {
        setPendingPlan(null);
        cachePatch.pendingPlan = null;
      }
    }

    if (patch.planModeEnabled !== undefined) {
      setPlanModeEnabled(patch.planModeEnabled);
      cachePatch.planModeEnabled = patch.planModeEnabled;
    }

    if (patch.isCompacting !== undefined) {
      setIsCompacting(patch.isCompacting);
      cachePatch.isCompacting = patch.isCompacting;
      const patchSessionId = activeSessionRef.current;
      if (patchSessionId) {
        setSessionsCompacting((prev) => {
          const next = new Set(prev);
          if (patch.isCompacting) { next.add(patchSessionId); } else { next.delete(patchSessionId); }
          return next;
        });
      }
      if (patch.viewerStatusOverride) {
        setViewerStatus(patch.viewerStatusOverride);
      } else if (!patch.isCompacting) {
        setViewerStatus((prev) => (prev === "Compacting…" ? "Connected" : prev));
      }
    } else if (patch.viewerStatusOverride) {
      setViewerStatus(patch.viewerStatusOverride);
    }

    if ("retryState" in patch) {
      setRetryState(patch.retryState ?? null);
    }

    if ("pluginTrustPrompt" in patch) {
      if (patch.pluginTrustPrompt) {
        const pt = patch.pluginTrustPrompt;
        if (pt.promptId && Array.isArray(pt.pluginNames) && pt.pluginNames.length > 0) {
          setPluginTrustPrompt({
            promptId: pt.promptId,
            pluginNames: pt.pluginNames,
            pluginSummaries: Array.isArray(pt.pluginSummaries) ? pt.pluginSummaries : pt.pluginNames,
          });
        }
      } else {
        setPluginTrustPrompt(null);
      }
    }

    if (patch.tokenUsage !== undefined) {
      setTokenUsage(patch.tokenUsage);
      cachePatch.tokenUsage = patch.tokenUsage;
    }

    if (patch.providerUsage !== undefined) {
      setProviderUsage(patch.providerUsage);
      cachePatch.providerUsage = patch.providerUsage;
    }

    if (patch.thinkingLevel !== undefined) {
      setEffortLevel(patch.thinkingLevel);
      cachePatch.effortLevel = patch.thinkingLevel;
    }

    if (patch.authSource !== undefined) {
      setAuthSource(patch.authSource);
      cachePatch.authSource = patch.authSource;
    }

    if (patch.model !== undefined) {
      if (patch.model) {
        const m = normalizeModel(patch.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      } else {
        // model_changed with null — clear the active model
        setActiveModel(null);
        cachePatch.activeModel = null;
      }
    }

    if (Object.keys(cachePatch).length > 0) {
      patchSessionCache(cachePatch);
    }
  }, [patchSessionCache]);

  const handleRelayEvent = React.useCallback((event: unknown, seq?: number) => {
    if (!event || typeof event !== "object") return;

    const evt = event as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";

    // Clear the snapshot guard when we receive a state-setting event.
    // These events replace the entire message list, so any pre-snapshot
    // deltas that snuck through are harmless (they'll be overwritten).
    // NOTE: heartbeat must NOT clear this flag — the server sends heartbeat
    // before addViewer() completes (viewer.ts:383-395), so clearing on HB
    // would drop the guard before the viewer is in the room, allowing
    // in-flight chunks or deltas to be accepted and then overwritten by
    // the later snapshot header.
    if (type === "session_active" || type === "agent_end") {
      awaitingSnapshotRef.current = false;
    }

    // While awaiting the initial snapshot OR during chunked hydration, skip
    // streaming delta events.  They'd render briefly and then be replaced
    // when the snapshot arrives, causing visible "jumping".  During chunked
    // delivery, live events can interleave with historical chunks and produce
    // an out-of-order transcript.  This also covers tool execution events —
    // without this guard, tool_execution_update partials can write synthetic
    // toolResult messages into state before the snapshot hydrates the real
    // conversation, producing orphan/duplicate tool output on reconnect.
    if (awaitingSnapshotRef.current || chunkedDeliveryRef.current) {
      if (
        type === "message_update" || type === "message_start" || type === "message_end" || type === "turn_end" ||
        type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end"
      ) {
        return;
      }
    }

    if (type === "heartbeat") {
      const hb = evt as {
        active?: boolean;
        isCompacting?: boolean;
        model?: { provider: string; id: string; name?: string } | null;
        sessionName?: string | null;
        ts?: number;
        /** Old (fat) CLI heartbeats may carry mcpStartupReport inline. */
        mcpStartupReport?: Record<string, unknown> | null;
      };

      const nextAgentActive = hb.active === true;
      const nextIsCompacting = hb.isCompacting === true;
      const cachePatch: Partial<SessionUiCacheEntry> = {
        agentActive: nextAgentActive,
        isCompacting: nextIsCompacting,
      };

      setAgentActive(nextAgentActive);
      setIsCompacting(nextIsCompacting);

      const hbSessionId = activeSessionRef.current;
      if (hbSessionId) {
        setSessionsCompacting((prev) => {
          const next = new Set(prev);
          if (nextIsCompacting) { next.add(hbSessionId); } else { next.delete(hbSessionId); }
          return next;
        });
      }

      if (nextIsCompacting) {
        setViewerStatus("Compacting…");
      } else {
        setViewerStatus((prev) => (prev === "Compacting…" ? "Connected" : prev));
      }

      if (typeof hb.ts === "number") {
        setLastHeartbeatAt(hb.ts);
        cachePatch.lastHeartbeatAt = hb.ts;
      }


      if ((hb as any).providerUsage !== undefined) {
        const nextProviderUsage = (hb as any).providerUsage ?? null;
        setProviderUsage(nextProviderUsage);
        cachePatch.providerUsage = nextProviderUsage;
      }

      if ((hb as any).authSource !== undefined) {
        const nextAuthSource = typeof (hb as any).authSource === "string" ? (hb as any).authSource : null;
        setAuthSource(nextAuthSource);
        cachePatch.authSource = nextAuthSource;
      }

      if ((hb as any).workerType !== undefined) {
        const nextWorkerType = typeof (hb as any).workerType === "string" ? (hb as any).workerType : "pi";
        setWorkerType(nextWorkerType);
        cachePatch.workerType = nextWorkerType;
      }


      if (Object.prototype.hasOwnProperty.call(hb, "sessionName")) {
        const nextName = normalizeSessionName(hb.sessionName);
        setSessionName(nextName);
        cachePatch.sessionName = nextName;
      }


      if (Array.isArray((hb as any).todoList)) {
        const todos = (hb as any).todoList as TodoItem[];
        setTodoList(todos);
        cachePatch.todoList = todos;
      }

      // Restore pending AskUserQuestion state when reconnecting to a session.
      if (Object.prototype.hasOwnProperty.call(hb, "pendingQuestion")) {
        const pq = (hb as any).pendingQuestion as { toolCallId: string; questions?: Array<{ question: string; options: string[] }>; display?: string; question?: string; options?: string[] } | null;
        if (pq) {
          const questions = parsePendingQuestions(pq);
          if (questions.length > 0) {
            const resolved = {
              toolCallId: typeof pq.toolCallId === "string" ? pq.toolCallId : getFallbackPromptKey(questions),
              questions,
              display: parsePendingQuestionDisplayMode(pq, questions.length),
            };
            setPendingQuestion(resolved);
            cachePatch.pendingQuestion = resolved;
            setViewerStatus("Waiting for answer…");
          } else {
            setPendingQuestion(null);
            cachePatch.pendingQuestion = null;
          }
        } else {
          // Heartbeat explicitly says no pending question; clear any stale state.
          setPendingQuestion(null);
          cachePatch.pendingQuestion = null;
        }
      }

      // Restore pending plan mode state when reconnecting to a session.
      if (Object.prototype.hasOwnProperty.call(hb, "pendingPlan")) {
        const pp = (hb as any).pendingPlan as {
          toolCallId: string;
          title: string;
          description?: string | null;
          steps?: Array<{ title: string; description?: string }>;
        } | null;
        if (pp && typeof pp.toolCallId === "string" && typeof pp.title === "string" && pp.title.trim()) {
          const steps = Array.isArray(pp.steps)
            ? pp.steps.filter((s): s is { title: string; description?: string } =>
                s !== null && typeof s === "object" && typeof s.title === "string" && s.title.trim().length > 0,
              )
            : [];
          const resolved = {
            toolCallId: pp.toolCallId,
            title: pp.title.trim(),
            description: typeof pp.description === "string" && pp.description.trim() ? pp.description.trim() : null,
            steps,
          };
          setPendingPlan(resolved);
          cachePatch.pendingPlan = resolved;
          setViewerStatus("Waiting for plan review…");
        } else {
          setPendingPlan(null);
          cachePatch.pendingPlan = null;
        }
      }

      // Restore pending permission prompts when reconnecting.
      if (Object.prototype.hasOwnProperty.call(hb, "pendingPermission")) {
        const pp = (hb as any).pendingPermission as {
          requestId: string;
          toolName?: string;
          toolInput?: unknown;
          ts?: number;
        } | null;
        if (pp && typeof pp.requestId === "string") {
          setPendingPermission({
            requestId: pp.requestId,
            toolName: typeof pp.toolName === "string" ? pp.toolName : "Unknown",
            toolInput: pp.toolInput ?? null,
            ts: typeof pp.ts === "number" ? pp.ts : Date.now(),
          });
        } else {
          setPendingPermission(null);
        }
      }

      // Track auto-retry state from CLI so we can show a retry indicator.
      if (Object.prototype.hasOwnProperty.call(hb, "retryState")) {
        const rs = (hb as any).retryState as { errorMessage: string; detectedAt: number } | null;
        setRetryState(rs);
      }

      // Restore pending plugin trust prompt when reconnecting.
      if (Object.prototype.hasOwnProperty.call(hb, "pendingPluginTrust")) {
        const pt = (hb as any).pendingPluginTrust as {
          promptId: string;
          pluginNames: string[];
          pluginSummaries: string[];
        } | null;
        if (pt && typeof pt.promptId === "string" && Array.isArray(pt.pluginNames) && pt.pluginNames.length > 0) {
          setPluginTrustPrompt({
            promptId: pt.promptId,
            pluginNames: pt.pluginNames,
            pluginSummaries: Array.isArray(pt.pluginSummaries) ? pt.pluginSummaries : pt.pluginNames,
          });
        } else {
          setPluginTrustPrompt(null);
        }
      }

      // Heartbeats also carry the current model; keep activeModel in sync.

      if (hb.model) {
        const m = normalizeModel(hb.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      }

      if (hb.mcpStartupReport && typeof hb.mcpStartupReport === "object") {
        applyMcpReport(hb.mcpStartupReport);
      }

      patchSessionCache(cachePatch);
      return;
    }

    if (type === "todo_update") {
      const todos = Array.isArray(evt.todos) ? (evt.todos as TodoItem[]) : [];
      setTodoList(todos);
      patchSessionCache({ todoList: todos });
      return;
    }

    if (type === "capabilities") {
      const modelsRaw = Array.isArray(evt.models) ? (evt.models as unknown[]) : [];
      const commandsRaw = Array.isArray(evt.commands) ? (evt.commands as unknown[]) : [];

      const normalizedModels = normalizeModelList(modelsRaw);
      const normalizedCommands = commandsRaw
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string")
        .map((c) => ({ name: String(c.name), description: typeof c.description === "string" ? c.description : undefined, source: typeof c.source === "string" ? c.source : undefined }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Keep model state in sync with capability snapshots too.
      setAvailableModels(normalizedModels);
      setAvailableCommands(normalizedCommands);
      patchSessionCache({ availableModels: normalizedModels, availableCommands: normalizedCommands });
      return;
    }

    if (type === "session_metadata_update") {
      // Lightweight metadata-only heartbeat — messages haven't changed.
      // Update metadata state without touching the messages array.
      const meta = (evt.metadata ?? {}) as Record<string, unknown>;
      const cachePatch: Partial<SessionUiCacheEntry> = {};

      const metaModel = normalizeModel(meta.model);
      if (metaModel) {
        setActiveModel(metaModel);
        cachePatch.activeModel = metaModel;
      }

      const metaModels = Array.isArray(meta.availableModels)
        ? normalizeModelList(meta.availableModels as unknown[])
        : null;
      if (metaModels) {
        setAvailableModels(metaModels);
        cachePatch.availableModels = metaModels;
      }

      if (Object.prototype.hasOwnProperty.call(meta, "sessionName")) {
        const nextName = normalizeSessionName(meta.sessionName);
        setSessionName(nextName);
        cachePatch.sessionName = nextName;
      }

      if (Object.prototype.hasOwnProperty.call(meta, "thinkingLevel")) {
        const level = typeof meta.thinkingLevel === "string" ? meta.thinkingLevel : null;
        setEffortLevel(level);
        cachePatch.effortLevel = level;
      }

      if (Array.isArray(meta.todoList)) {
        const todos = meta.todoList as TodoItem[];
        setTodoList(todos);
        cachePatch.todoList = todos;
      }

      if (Object.keys(cachePatch).length > 0) {
        patchSessionCache(cachePatch);
      }
      return;
    }

    if (type === "session_active") {
      const state = evt.state as Record<string, unknown> | undefined;
      const rawMessages = Array.isArray(state?.messages) ? (state?.messages as unknown[]) : [];
      const isChunked = !!state?.chunked;
      const stateModel = normalizeModel(state?.model);
      const stateModels = Array.isArray(state?.availableModels)
        ? normalizeModelList(state.availableModels as unknown[])
        : [];
      const normalizedMessages = normalizeMessages(rawMessages);
      const hasSessionName = !!state && Object.prototype.hasOwnProperty.call(state, "sessionName");
      const nextSessionName = hasSessionName ? normalizeSessionName(state?.sessionName) : null;

      // Flush any queued streaming-delta RAF before replacing state so stale
      // partials can't be re-inserted on top of the fresh snapshot.
      cancelPendingDeltas();
      // Re-append locally-injected messages (e.g. MCP auth banners) that
      // aren't part of the server-side state snapshot.
      const injected = injectedMessagesRef.current;
      setMessages(injected.length > 0 ? [...normalizedMessages, ...injected] : normalizedMessages);
      setActiveModel(stateModel);
      if (hasSessionName) {
        setSessionName(nextSessionName);
      }
      setAvailableModels(stateModels);

      // Track chunked delivery state — messages arrive as subsequent
      // session_messages_chunk events when the session is large.
      if (isChunked) {
        const totalMessages = typeof state?.totalMessages === "number" ? state.totalMessages : 0;
        const snapshotId = typeof state?.snapshotId === "string" ? state.snapshotId : "";
        chunkedDeliveryRef.current = {
          snapshotId,
          totalMessages,
          totalChunks: 0, // updated as chunks arrive
          receivedChunkIndexes: new Set<number>(),
          finalChunkSeen: false,
          loadedMessages: 0,
          chunkBuffer: new Map<number, unknown[]>(),
        };
        setViewerStatus(`Loading session (0 of ${totalMessages} messages)…`);
      } else {
        chunkedDeliveryRef.current = null;
        // Mark that we have a complete non-chunked snapshot so any stale
        // chunks from a superseded chunked sender are rejected.
        lastCompletedSnapshotRef.current = "non-chunked";
      }

      // Don't clobber transient statuses with a generic "Connected" when the
      // CLI sends a session_active snapshot right after a command.
      if (!isChunked) {
        setViewerStatus((prev) => {
          if (prev === "Model set" || prev === "Compacting…" || prev.startsWith("Compacted")) return prev;
          return "Connected";
        });
      }

      // Don't unconditionally clear pendingQuestion / pendingPlan here.
      // session_active is also emitted for non-session-switch actions (model
      // changes, thinking-level updates) and buildSessionState() doesn't carry
      // these transient states.  The heartbeat already manages them; clearing
      // here would cause the action buttons to disappear until the next HB.
      // pendingQuestion and pendingPlan are cleared on session_switch / new_session
      // through the heartbeat (which sets them to null when the runner has none).
      setPluginTrustPrompt(null);
      // Restore in-flight tool calls from the snapshot so reconnecting mid-command
      // keeps streaming indicators and Kill buttons visible. The snapshot payload
      // doesn't include explicit active-tool IDs, so we infer them by scanning
      // for toolCall blocks that have no matching toolResult.
      if (!isChunked) {
        setActiveToolCalls(detectInFlightTools(normalizedMessages));
      } else {
        // Clear stale tool call state from before the reconnect so old
        // streaming badges and Kill buttons don't linger while chunks load.
        setActiveToolCalls(new Map());
      }
      setIsChangingModel(false);
      sessionHydratedRef.current = !isChunked; // defer until final chunk
      // For non-chunked sessions, flush any pending MCP report immediately
      if (!isChunked && pendingMcpReportRef.current) {
        applyMcpReport(pendingMcpReportRef.current);
        pendingMcpReportRef.current = null;
      }

      // Clear queued messages — the snapshot contains the full conversation
      // including any follow-ups that were consumed by the agent.
      setMessageQueue([]);

      // Extract thinkingLevel from session snapshot too
      const thinkingLevel = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
      setEffortLevel(thinkingLevel);

      // Extract todoList from session snapshot
      const stateTodos = Array.isArray(state?.todoList) ? (state.todoList as TodoItem[]) : [];
      setTodoList(stateTodos);

      // Extract workerType from session snapshot (defaults to "pi")
      const stateWorkerType = typeof state?.workerType === "string" ? state.workerType : "pi";
      setWorkerType(stateWorkerType);

      // Rehydrate pending permission request from the snapshot so that the
      // permission card is shown immediately on reconnect, without waiting
      // for the next heartbeat.  The heartbeat also carries pendingPermission
      // and acts as the authoritative state, but the snapshot restores it
      // synchronously so there is no visible gap while the HB travels.
      const snapshotPP = state?.pendingPermission as Record<string, unknown> | null | undefined;
      if (snapshotPP && typeof snapshotPP.requestId === "string") {
        setPendingPermission({
          requestId: snapshotPP.requestId,
          toolName: typeof snapshotPP.toolName === "string" ? snapshotPP.toolName : "Unknown",
          toolInput: snapshotPP.toolInput ?? null,
          ts: typeof snapshotPP.ts === "number" ? snapshotPP.ts : Date.now(),
        });
      } else if (Object.prototype.hasOwnProperty.call(state ?? {}, "pendingPermission")) {
        // Snapshot explicitly carries null — clear any stale card.
        setPendingPermission(null);
      }

      patchSessionCache({
        messages: normalizedMessages,
        activeModel: stateModel,
        ...(hasSessionName ? { sessionName: nextSessionName } : {}),
        availableModels: stateModels,
        effortLevel: thinkingLevel,
        todoList: stateTodos,
        workerType: stateWorkerType,
      });
      return;
    }

    // ── Chunked message delivery ───────────────────────────────────────────
    // Large sessions send messages as a series of chunks after the metadata-only
    // session_active event. Each chunk appends to the current messages array.
    if (type === "session_messages_chunk") {
      // Ignore chunks that arrive before the matching session_active header.
      // This can happen when a viewer joins mid-stream: the room broadcast
      // delivers in-flight chunks before the viewer's initial snapshot replay.
      // Without this guard, chunks are appended to stale/empty state and then
      // the later metadata-only session_active clears them with setMessages([]).
      if (awaitingSnapshotRef.current && !chunkedDeliveryRef.current) {
        return;
      }

      const chunkSnapshotId = typeof evt.snapshotId === "string" ? evt.snapshotId : "";
      const chunkIndex = typeof evt.chunkIndex === "number" ? evt.chunkIndex : -1;
      const chunkMessages = Array.isArray(evt.messages) ? evt.messages as unknown[] : [];
      const isFinal = !!evt.final;
      const totalChunks = typeof evt.totalChunks === "number" ? evt.totalChunks : 0;
      const totalMessages = typeof evt.totalMessages === "number" ? evt.totalMessages : 0;

      // Discard chunks from a stale snapshot stream.  Two cases:
      // 1) A newer snapshot is actively loading (ref is non-null, IDs differ).
      // 2) A snapshot already completed (ref is null) but late chunks from
      //    the superseded sender are still draining — reject if the ID
      //    doesn't match the last completed snapshot.
      if (chunkSnapshotId) {
        if (chunkedDeliveryRef.current && chunkedDeliveryRef.current.snapshotId !== chunkSnapshotId) {
          return; // stale chunk — a newer snapshot is loading
        }
        if (!chunkedDeliveryRef.current && lastCompletedSnapshotRef.current && lastCompletedSnapshotRef.current !== chunkSnapshotId) {
          return; // stale chunk — arrived after a newer snapshot completed
        }
      }

      const chunkState = chunkedDeliveryRef.current;
      if (!chunkState || chunkIndex < 0) {
        return;
      }

      if (isFinal) {
        chunkState.finalChunkSeen = true;
      }

      // Idempotency: duplicate retransmits for the same chunkIndex are ignored.
      if (!registerChunkIndex(chunkState.receivedChunkIndexes, chunkIndex)) {
        return;
      }

      if (Number.isInteger(totalChunks) && totalChunks > 0) {
        chunkState.totalChunks = totalChunks;
      }

      // Buffer this chunk's raw messages by chunkIndex so we can assemble
      // in index order at finalization time. Out-of-order delivery means we
      // must NOT use arrival order — chunk 2 arriving before chunk 1 would
      // produce a scrambled transcript if we append immediately.
      chunkState.chunkBuffer.set(chunkIndex, chunkMessages);

      // Update progress counter for status display.
      chunkState.loadedMessages += chunkMessages.length;
      const loaded = chunkState.loadedMessages;
      setViewerStatus(`Loading session (${Math.min(loaded, totalMessages)} of ${totalMessages} messages)…`);

      const readyToFinalize = canFinalizeChunkHydration(
        chunkState.finalChunkSeen,
        chunkState.receivedChunkIndexes,
        chunkState.totalChunks,
      );

      if (readyToFinalize) {
        // Assemble all buffered chunks in chunkIndex order so the resulting
        // transcript matches the original server-side ordering regardless of
        // network delivery order.
        const sortedIndexes = Array.from(chunkState.chunkBuffer.keys()).sort((a, b) => a - b);
        const orderedRaw: unknown[] = [];
        for (const idx of sortedIndexes) {
          const buf = chunkState.chunkBuffer.get(idx);
          if (buf) {
            for (const m of buf) orderedRaw.push(m);
          }
        }
        // Convert the ordered raw messages with stable sequential keys and
        // deduplicate the complete assembled list in one pass.
        const convertedOrdered = orderedRaw
          .map((m, i) => toRelayMessage(m, `snapshot-${i}`))
          .filter((m): m is RelayMessage => m !== null);
        const finalMessages = deduplicateMessages(convertedOrdered);

        lastCompletedSnapshotRef.current = chunkSnapshotId || null;
        chunkedDeliveryRef.current = null;
        sessionHydratedRef.current = true;
        // Flush any MCP startup report that arrived before hydration completed
        if (pendingMcpReportRef.current) {
          applyMcpReport(pendingMcpReportRef.current);
          pendingMcpReportRef.current = null;
        }
        setViewerStatus("Connected");

        // Capture the merged result inside the updater so patchSessionCache
        // receives the same value that setMessages commits — including any
        // injected banners or system messages that are in prev but not in
        // the snapshot.  Using a plain variable here mirrors the mcpNext
        // pattern used in applyMcpReport; React calls functional updaters
        // synchronously when enqueuing the update so mergedMessages is
        // populated before patchSessionCache runs.
        let mergedMessages: RelayMessage[] = finalMessages;
        setMessages((prev) => {
          mergedMessages = mergeChunkSnapshot(finalMessages, prev);
          return mergedMessages;
        });
        setActiveToolCalls(detectInFlightTools(finalMessages));
        patchSessionCache({ messages: mergedMessages });
      }
      return;
    }

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      const normalized = normalizeMessages(evt.messages as unknown[]);
      cancelPendingDeltas();
      const injected = injectedMessagesRef.current;
      const withInjected = injected.length > 0 ? [...normalized, ...injected] : normalized;
      setMessages(withInjected);
      patchSessionCache({ messages: withInjected });
      setPendingQuestion(null);
      setPendingPlan(null);
      setPendingPermission(null);
      setRetryState(null);
      setActiveToolCalls(new Map());
      // Clear message queue — the agent processed any queued steer/followUp messages
      setMessageQueue([]);
      return;
    }

    if (type === "session_started") {
      // Runner emits { type: "session_started", model: { provider, modelId } }
      // Map modelId → id so normalizeModel can pick it up.
      const raw = evt.model as Record<string, unknown> | undefined;
      if (raw && typeof raw.modelId === "string") {
        const normalized = normalizeModel({ ...raw, id: raw.modelId });
        if (normalized) {
          setActiveModel(normalized);
          patchSessionCache({ activeModel: normalized });
        }
      }
      return;
    }

    if (type === "exec_result") {
      const ok = evt.ok === true;
      const command = typeof evt.command === "string" ? String(evt.command) : "";
      // result is the dynamic exec response payload — typed as Record for property access
      const result = evt.result as Record<string, unknown> | null | undefined;
      if (!ok) {
        const error = typeof evt.error === "string" ? evt.error : "Command failed";
        if (command === "list_resume_sessions") {
          setResumeSessionsLoading(false);
        }
        if (command === "refresh_usage") {
          setUsageRefreshing(false);
        }
        if (command === "compact") {
          // Don't force isCompacting=false here — let the heartbeat remain
          // the source of truth. The error may be "already in progress"
          // (compaction is still running), and unconditionally clearing the
          // flag would re-enable input prematurely until the next heartbeat.
        }
        setViewerStatus(`/${command}: ${error}`);
        return;
      }

      if (command === "refresh_usage") {
        const nextUsage = result?.providerUsage && typeof result.providerUsage === "object"
          ? (result.providerUsage as ProviderUsageMap)
          : null;
        setUsageRefreshing(false);
        if (nextUsage) {
          setProviderUsage(nextUsage);
          patchSessionCache({ providerUsage: nextUsage });
        }
        setViewerStatus("Usage refreshed");
        return;
      }

      if (command === "list_resume_sessions") {
        const list: unknown[] = Array.isArray(result?.sessions) ? (result.sessions as unknown[]) : [];
        const normalized: ResumeSessionOption[] = [];

        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const entry = item as Record<string, unknown>;
          if (typeof entry.id !== "string" || typeof entry.path !== "string" || typeof entry.modified !== "string") {
            continue;
          }
          normalized.push({
            id: entry.id,
            path: entry.path,
            name: typeof entry.name === "string" ? entry.name : null,
            modified: entry.modified,
            firstMessage: typeof entry.firstMessage === "string" ? entry.firstMessage : undefined,
          });
        }

        setResumeSessions(normalized);
        setResumeSessionsLoading(false);
        if (normalized.length === 0) {
          setViewerStatus("No resumable sessions");
        }
        return;
      }

      if (command === "get_last_assistant_text") {
        const text = typeof result?.text === "string" ? result.text : "";
        if (text) {
          void navigator.clipboard.writeText(text);
          setViewerStatus("Copied");
        } else {
          setViewerStatus("Nothing to copy");
        }
        return;
      }

      if (command === "mcp") {
        // Build structured command result for rich card rendering
        const toolCount = typeof result?.toolCount === "number" ? result.toolCount : 0;
        const toolNames = Array.isArray(result?.toolNames)
          ? result.toolNames.filter((n: unknown): n is string => typeof n === "string")
          : [];
        const errors = Array.isArray(result?.errors) ? result.errors as Array<{ server: string; error: string }> : [];
        const mcpConfig = result?.config && typeof result.config === "object" ? result.config as Record<string, unknown> : null;
        const servers = Array.isArray(mcpConfig?.effectiveServers)
          ? (mcpConfig.effectiveServers as Array<{ name: string; transport: string; scope: string; sourcePath?: string }>)
          : [];
        const action = typeof result?.action === "string" && result.action === "reload" ? "reload" as const : "status" as const;
        // serverTools: Record<string, string[]> — tools grouped by MCP server name
        const serverTools = result?.serverTools && typeof result.serverTools === "object" && !Array.isArray(result.serverTools)
          ? result.serverTools as Record<string, string[]>
          : {};

        const disabledServersForMcp = Array.isArray(mcpConfig?.disabledServers)
          ? (mcpConfig.disabledServers as unknown[]).filter((s: unknown): s is string => typeof s === "string")
          : [];

        appendLocalSystemMessage({
          kind: "mcp",
          action,
          toolCount,
          toolNames,
          serverCount: servers.length,
          servers,
          errors,
          serverTools,
          disabledServers: disabledServersForMcp,
          loadedAt: typeof result?.loadedAt === "string" ? result.loadedAt : undefined,
        });

        const summary = typeof result?.summary === "string"
          ? result.summary
          : `MCP tools loaded: ${toolCount}`;
        setViewerStatus(summary);
        return;
      }

      if (command === "mcp_toggle_server") {
        // Build the same structured card as /mcp status, showing updated state
        const toolCount = typeof result?.toolCount === "number" ? result.toolCount : 0;
        const toolNames = Array.isArray(result?.toolNames)
          ? result.toolNames.filter((n: unknown): n is string => typeof n === "string")
          : [];
        const errors = Array.isArray(result?.errors) ? result.errors as Array<{ server: string; error: string }> : [];
        const toggleConfig = result?.config && typeof result.config === "object" ? result.config as Record<string, unknown> : null;
        const servers = Array.isArray(toggleConfig?.effectiveServers)
          ? (toggleConfig.effectiveServers as Array<{ name: string; transport: string; scope: string; sourcePath?: string }>)
          : [];
        const serverTools = result?.serverTools && typeof result.serverTools === "object" && !Array.isArray(result.serverTools)
          ? result.serverTools as Record<string, string[]>
          : {};
        const disabledServers = Array.isArray(toggleConfig?.disabledServers)
          ? (toggleConfig.disabledServers as unknown[]).filter((s: unknown): s is string => typeof s === "string")
          : [];
        const toggledServer = typeof result?.toggledServer === "string" ? result.toggledServer : "";
        const disabled = result?.disabled === true;

        appendLocalSystemMessage({
          kind: "mcp",
          action: "reload" as const,
          toolCount,
          toolNames,
          serverCount: servers.length,
          servers,
          errors,
          serverTools,
          disabledServers,
          loadedAt: typeof result?.loadedAt === "string" ? result.loadedAt : undefined,
        });

        const verb = disabled ? "Disabled" : "Enabled";
        setViewerStatus(`${verb} MCP server "${toggledServer}". ${toolCount} tools loaded.`);
        return;
      }

      if (command === "cycle_thinking_level" || command === "set_thinking_level") {
        const newLevel = typeof result?.thinkingLevel === "string" ? result.thinkingLevel : null;
        setEffortLevel(newLevel);
        patchSessionCache({ effortLevel: newLevel });
        setViewerStatus(newLevel && newLevel !== "off" ? `Effort: ${newLevel}` : "Effort: off");
        return;
      }

      if (command === "set_plan_mode") {
        const enabled = !!result?.planModeEnabled;
        setPlanModeEnabled(enabled);
        patchSessionCache({ planModeEnabled: enabled });
        setViewerStatus(enabled ? "⏸ Plan mode ON" : "▶ Plan mode OFF");
        return;
      }

      if (command === "set_session_name") {
        const nextSessionName = normalizeSessionName(result?.sessionName);
        setSessionName(nextSessionName);
        patchSessionCache({ sessionName: nextSessionName });
        setViewerStatus(nextSessionName ? "Session renamed" : "Session name cleared");
        return;
      }

      if (command === "set_model" || command === "cycle_model") {
        setViewerStatus("Model set");
        // Runner should also emit session_active/model_select, but in case it doesn't,
        // opportunistically refresh capabilities by asking for commands again (cheap).
        return;
      }

      if (command === "compact") {
        setIsCompacting(false);
        const compactDoneId = activeSessionRef.current;
        if (compactDoneId) {
          setSessionsCompacting((prev) => { const next = new Set(prev); next.delete(compactDoneId); return next; });
        }
        const tokensBefore = typeof result?.tokensBefore === "number" ? result.tokensBefore : 0;
        const summary = typeof result?.summary === "string"
          ? `Compacted (${tokensBefore > 0 ? `${Math.round(tokensBefore / 1000)}k tokens summarized` : "done"})`
          : "Compacted";
        setViewerStatus(summary);
        // Clear the compact status after a few seconds so it doesn't stick forever
        setTimeout(() => setViewerStatus((prev) => (prev === summary || prev.startsWith("Compacted") ? "Connected" : prev)), 5000);
        return;
      }

      if (command === "new_session") {
        cancelPendingDeltas();
        injectedMessagesRef.current = [];
        setMessages([]);
        setPendingQuestion(null);
        setPendingPlan(null);
        setMcpOAuthPastes([]);
        setActiveToolCalls(new Map());
        setMessageQueue([]);
        setSessionName(null);
        setAgentActive(false);
        patchSessionCache({
          messages: [],
          sessionName: null,
          agentActive: false,
        });
        // Clear trigger history so the Triggers panel starts fresh
        const sid = activeSessionRef.current;
        if (sid) {
          void fetch(`/api/sessions/${encodeURIComponent(sid)}/triggers`, {
            method: "DELETE",
            credentials: "include",
          }).catch(() => {});
        }
        setViewerStatus("New session started");
        return;
      }

      if (command === "restart") {
        setViewerStatus("Restarting CLI…");
        // Remember which session is restarting so we can auto-reconnect when it
        // comes back live.  The session ID is stable across a restart (PIZZAPI_SESSION_ID).
        const pendingId = activeSessionRef.current;
        if (pendingId) {
          restartPendingSessionIdRef.current = pendingId;
          if (restartPendingTimerRef.current) clearTimeout(restartPendingTimerRef.current);
          // Give up auto-reconnect after 60 s in case the CLI never comes back.
          restartPendingTimerRef.current = setTimeout(() => {
            restartPendingSessionIdRef.current = null;
            restartPendingTimerRef.current = null;
          }, 60_000);
        }
        return;
      }

      if (command === "end_session") {
        setViewerStatus("Ending session…");
        return;
      }

      if (command === "resume_session") {
        setViewerStatus("Session resumed");
        return;
      }

      setViewerStatus("OK");
      return;
    }

    if (type === "mcp_startup_report") {
      const report = evt as {
        slow?: boolean;
        showSlowWarning?: boolean;
        errors?: Array<{ server: string; error: string }>;
        serverTimings?: Array<{
          name: string;
          durationMs: number;
          toolCount: number;
          timedOut: boolean;
          error?: string;
        }>;
        totalDurationMs?: number;
        ts?: number;
      };
      applyMcpReport(report);
      return;
    }

    if (type === "mcp_auth_required") {
      const serverName = typeof evt.serverName === "string" ? evt.serverName : "MCP server";
      const authUrl = typeof evt.authUrl === "string" ? evt.authUrl : null;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();

      // Only render clickable link for safe http/https URLs to prevent XSS
      const isSafeUrl = (() => {
        try { const p = new URL(authUrl ?? ""); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; }
      })();
      if (authUrl && isSafeUrl) {
        const stableKey = `mcp_auth:${serverName}`;
        const message: RelayMessage = {
          key: stableKey,
          role: "system",
          timestamp: ts,
          content: `🔐 **${serverName}** requires authentication.\n\n[Click here to authenticate](${authUrl})`,
          isError: false,
        };
        // Store in ref so it survives wholesale setMessages replacements.
        // Upsert: replace existing message for this server (URL/state may
        // have changed on retry), or append if first time.
        const idx = injectedMessagesRef.current.findIndex((m) => m.key === stableKey);
        if (idx >= 0) {
          injectedMessagesRef.current = injectedMessagesRef.current.map((m) => m.key === stableKey ? message : m);
          setMessages((prev) => prev.map((m) => m.key === stableKey ? message : m));
        } else {
          injectedMessagesRef.current = [...injectedMessagesRef.current, message];
          const next = [...messagesRef.current, message];
          setMessages(next);
          patchSessionCache({ messages: next });
        }
      }
      return;
    }

    if (type === "mcp_auth_paste_required") {
      const serverName = typeof evt.serverName === "string" ? evt.serverName : "MCP server";
      const authUrl = typeof evt.authUrl === "string" ? evt.authUrl : null;
      const nonce = typeof evt.nonce === "string" ? evt.nonce : null;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();

      if (authUrl && nonce) {
        // Inject a system message pointing to the paste component.
        // Use a stable key (no timestamp) so re-emitted events replace
        // the existing message instead of accumulating duplicates.
        const stableKey = `mcp_auth:${serverName}`;
        const message: RelayMessage = {
          key: stableKey,
          role: "system",
          timestamp: ts,
          content: `🔐 **${serverName}** requires authentication — use the prompt below to sign in.`,
          isError: false,
        };
        // Upsert: replace existing message (nonce/URL may change on retry)
        const idx = injectedMessagesRef.current.findIndex((m) => m.key === stableKey);
        if (idx >= 0) {
          injectedMessagesRef.current = injectedMessagesRef.current.map((m) => m.key === stableKey ? message : m);
          setMessages((prev) => prev.map((m) => m.key === stableKey ? message : m));
        } else {
          injectedMessagesRef.current = [...injectedMessagesRef.current, message];
          const next = [...messagesRef.current, message];
          setMessages(next);
          patchSessionCache({ messages: next });
        }
        // Add/update pending paste prompt (always update nonce/authUrl)
        setMcpOAuthPastes((prev) => [
          ...prev.filter((p) => p.serverName !== serverName),
          { serverName, authUrl, nonce, ts },
        ]);
      }
      return;
    }

    if (type === "mcp_auth_complete") {
      const serverName = typeof evt.serverName === "string" ? evt.serverName : "MCP server";
      const stableKey = `mcp_auth:${serverName}`;
      // Remove the auth banner for this server — auth succeeded
      injectedMessagesRef.current = injectedMessagesRef.current.filter(
        (m) => m.key !== stableKey && !m.key.startsWith(`${stableKey}:`),
      );
      // Also remove from rendered messages
      const filteredNext = messagesRef.current.filter(
        (m) => m.key !== stableKey && !m.key.startsWith(`${stableKey}:`),
      );
      if (filteredNext.length !== messagesRef.current.length) {
        setMessages(filteredNext);
        patchSessionCache({ messages: filteredNext });
      }
      // Remove from pending paste prompts
      setMcpOAuthPastes((prev) => prev.filter((p) => p.serverName !== serverName));
      return;
    }

    if (type === "cli_error") {
      const message = typeof evt.message === "string" ? evt.message : "An error occurred in the CLI";
      const source = typeof evt.source === "string" && evt.source ? evt.source : null;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();
      const label = source ? `CLI Error (${source})` : "CLI Error";
      const errMessage: RelayMessage = {
        key: `cli_error:${ts}:${Math.random().toString(16).slice(2)}`,
        role: "system",
        timestamp: ts,
        content: `⚠ ${label}: ${message}`,
        isError: true,
      };
      const next = [...messagesRef.current, errMessage];
      setMessages(next);
      patchSessionCache({ messages: next });
      return;
    }

    if (type === "model_select") {
      const selected = normalizeModel(evt.model);
      if (selected) {
        setActiveModel(selected);
        patchSessionCache({ activeModel: selected });
      }
      setIsChangingModel(false);
      return;
    }

    if (type === "model_set_result") {
      const ok = evt.ok === true;
      setIsChangingModel(false);
      if (ok) {
        // Keep wording consistent with "model_select" and make it clear the change succeeded.
        setViewerStatus("Model set");
      } else {
        const message = typeof evt.message === "string" ? evt.message : "Failed to set model";
        setViewerStatus(message);
      }
      return;
    }

    // ── Permission request from Claude Code worker ─────────────────────────
    if (type === "permission_request") {
      const e = evt as Record<string, unknown>;
      if (typeof e.requestId === "string") {
        setPendingPermission({
          requestId: e.requestId,
          toolName: typeof e.toolName === "string" ? e.toolName : "Unknown",
          toolInput: e.toolInput ?? null,
          ts: typeof e.ts === "number" ? e.ts : Date.now(),
        });
      }
      return;
    }

    if (type === "tool_execution_start") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
      if (toolCallId) {
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.set(toolCallId, toolName);
          if (prev.size === 0) startToolHaptic();
          return next;
        });
      }
    }

    if (type === "tool_execution_update") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
      // AskUserQuestion and plan_mode updates are handled separately below — skip here.
      if (toolCallId && toolName !== "AskUserQuestion" && toolName !== "plan_mode") {
        const partial = evt.partialResult as Record<string, unknown> | undefined;
        const content = partial?.content;
        if (content !== undefined && content !== null) {
          // Buffer the partial as a synthetic toolResult keyed by toolCallId.
          // The RAF-based scheduleToolStreamFlush will upsert it into message
          // state (at most once per frame), so the grouping code merges it with
          // the pending-tool card and the UI renders live output.
          //
          // For tools that send structured details (e.g., subagent), wrap content
          // with the details so the card component can render the full structure.
          const details = partial?.details;
          const syntheticContent = details
            ? { content, details }
            : content;
          pendingToolStreamRef.current.set(toolCallId, {
            role: "toolResult",
            toolCallId,
            toolName,
            content: syntheticContent,
            isError: false,
            // Mark as a streaming partial so deduplication logic does not
            // treat it as a terminal tool result (the tool is still in-flight).
            isStreamingPartial: true,
          });
          scheduleToolStreamFlush();
        }
      }
    }

    if (type === "tool_execution_end") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      if (toolCallId) {
        // Evict any buffered streaming partial for this tool call so a pending
        // RAF flush can't overwrite the final tool result that arrives shortly
        // via message_update/message_end.
        pendingToolStreamRef.current.delete(toolCallId);
        if (pendingToolStreamRef.current.size === 0 && toolStreamRafRef.current !== null) {
          cancelAnimationFrame(toolStreamRafRef.current);
          toolStreamRafRef.current = null;
        }
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.delete(toolCallId);
          if (next.size === 0) stopToolHaptic();
          return next;
        });
      }
    }

    if (type === "plugin_trust_prompt") {
      const promptId = evt.promptId as string | undefined;
      const names = evt.pluginNames as string[] | undefined;
      const summaries = evt.pluginSummaries as string[] | undefined;
      if (typeof promptId === "string" && Array.isArray(names) && names.length > 0) {
        setPluginTrustPrompt({
          promptId,
          pluginNames: names,
          pluginSummaries: Array.isArray(summaries) ? summaries : names,
        });
      }
      return;
    }

    if (type === "plugin_trust_expired") {
      const promptId = evt.promptId as string | undefined;
      setPluginTrustPrompt((prev) =>
        prev && prev.promptId === promptId ? null : prev
      );
      return;
    }

    if (type === "tool_execution_start" && evt.toolName === "AskUserQuestion") {
      const args = evt.args as Record<string, unknown> | undefined;
      const questions = parsePendingQuestions(args);

      if (questions.length > 0) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : getFallbackPromptKey(questions),
          questions,
          display: parsePendingQuestionDisplayMode(args, questions.length),
        });
        setViewerStatus("Waiting for answer…");
      }
      return;
    }

    if (type === "tool_execution_update" && evt.toolName === "AskUserQuestion") {
      const partial = evt.partialResult as Record<string, unknown> | undefined;
      const details = partial?.details as Record<string, unknown> | undefined;
      // Try from partial first, then nested details (parsePendingQuestions returns [] not falsy)
      const fromPartial = parsePendingQuestions(partial);
      const fromDetails = parsePendingQuestions(details);
      const usePartial = fromPartial.length > 0;
      const questions = usePartial ? fromPartial : fromDetails;
      const displaySource = usePartial ? partial : details;

      if (questions.length > 0) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : getFallbackPromptKey(questions),
          questions,
          display: parsePendingQuestionDisplayMode(displaySource, questions.length),
        });
      }
      return;
    }

    if (type === "tool_execution_end" && evt.toolName === "AskUserQuestion") {
      setPendingQuestion(null);
      setViewerStatus("Connected");
      return;
    }

    // ── plan_mode events ────────────────────────────────────────────────────
    if (type === "tool_execution_start" && evt.toolName === "plan_mode") {
      const args = evt.args as Record<string, unknown> | undefined;
      if (args && typeof args.title === "string" && args.title.trim()) {
        const steps = Array.isArray(args.steps)
          ? (args.steps as unknown[])
              .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
              .map((s) => ({
                title: typeof s.title === "string" ? (s.title as string).trim() : "",
                description: typeof s.description === "string" && (s.description as string).trim()
                  ? (s.description as string).trim()
                  : undefined,
              }))
              .filter((s) => s.title.length > 0)
          : [];
        setPendingPlan({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : `plan-${Date.now()}`,
          title: args.title.trim(),
          description: typeof args.description === "string" && args.description.trim() ? args.description.trim() : null,
          steps,
        });
        setViewerStatus("Waiting for plan review…");
      }
      return;
    }

    if (type === "tool_execution_update" && evt.toolName === "plan_mode") {
      const partial = evt.partialResult as Record<string, unknown> | undefined;
      const details = partial?.details as Record<string, unknown> | undefined;
      const source = details ?? partial;
      if (source && typeof source.title === "string" && source.title.trim()) {
        const steps = Array.isArray(source.steps)
          ? (source.steps as unknown[])
              .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
              .map((s) => ({
                title: typeof s.title === "string" ? (s.title as string).trim() : "",
                description: typeof s.description === "string" && (s.description as string).trim()
                  ? (s.description as string).trim()
                  : undefined,
              }))
              .filter((s) => s.title.length > 0)
          : [];
        setPendingPlan({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : `plan-${Date.now()}`,
          title: (source.title as string).trim(),
          description: typeof source.description === "string" && (source.description as string).trim() ? (source.description as string).trim() : null,
          steps,
        });
      }
      return;
    }

    if (type === "tool_execution_end" && evt.toolName === "plan_mode") {
      setPendingPlan(null);
      setViewerStatus("Connected");
      return;
    }

    if (type === "agent_end") {
      cancelHaptic();
      setActiveToolCalls(new Map());
      setPendingPermission(null);
    }

    if (type === "message_update") {
      const assistantEvent = evt.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent && assistantEvent.partial) {
        const deltaType = typeof assistantEvent.type === "string" ? assistantEvent.type : "";
        const contentIndex = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : -1;

        // Track wall-clock duration of each thinking block.
        if (deltaType === "thinking_start" && contentIndex >= 0) {
          thinkingStartTimesRef.current.set(contentIndex, Date.now());
        } else if (deltaType === "thinking_end" && contentIndex >= 0) {
          const startTime = thinkingStartTimesRef.current.get(contentIndex);
          if (startTime !== undefined) {
            const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
            thinkingDurationsRef.current.set(contentIndex, durationSeconds);
            thinkingStartTimesRef.current.delete(contentIndex);
          }
        }

        const isStreamingDelta =
          deltaType === "toolcall_delta" ||
          deltaType === "text_delta" ||
          deltaType === "thinking_delta";
        const partial = assistantEvent.partial as Record<string, unknown>;
        const raw = augmentThinkingDurations({ ...partial, timestamp: undefined }, thinkingDurationsRef.current);
        if (isStreamingDelta) {
          if (deltaType === "text_delta" || deltaType === "thinking_delta") {
            const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
            pulseStreamingHaptic(delta);
          }
          upsertMessageDebounced(raw, "message-update-partial");
        } else {
          upsertMessage(raw, "message-update-partial");
        }
        return;
      }
      upsertMessage(evt.message, "message-update");
      return;
    }

    if (type === "message_start") {
      upsertMessage(evt.message, type);
      // When a user message appears in the stream, remove the matching queued message
      removeQueuedMessageByContent(evt.message);
    }

    if (type === "message_end" || type === "turn_end") {
      cancelHaptic();
      upsertMessage(augmentThinkingDurations(evt.message, thinkingDurationsRef.current), type, true);
      // When a user message appears in the stream, remove the matching queued message
      removeQueuedMessageByContent(evt.message);
      // Reset for the next assistant message.
      thinkingStartTimesRef.current = new Map();
      thinkingDurationsRef.current = new Map();
    }
  }, [
    upsertMessage,
    upsertMessageDebounced,
    cancelPendingDeltas,
    appendLocalSystemMessage,
    scheduleToolStreamFlush,
    applyMcpReport,
    getFallbackPromptKey,
    patchSessionCache,
    removeQueuedMessageByContent,
  ]);

  React.useEffect(() => {
    const socket = io("/hub", {
      withCredentials: true,
      auth: {
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        clientVersion: UI_VERSION,
      },
    });
    hubSocketRef.current = socket;
    setHubSocket(socket);

    const handleStateSnapshot = ({ sessionId, state }: { sessionId: string; state: SessionMetaState }) => {
      const currentSessionId = activeSessionRef.current;

      // For background sessions: extract pendingQuestion/pendingPlan from the
      // initial state_snapshot so badges are correct on load/reconnect even
      // when the session is already blocked waiting for user input.
      if (sessionId !== currentSessionId) {
        if (Object.prototype.hasOwnProperty.call(state, "pendingQuestion") ||
            Object.prototype.hasOwnProperty.call(state, "pendingPlan")) {
          setSessionsAwaitingInput((prev) => {
            const next = new Set(prev);
            if (state.pendingQuestion || state.pendingPlan) {
              next.add(sessionId);
            } else {
              next.delete(sessionId);
            }
            return next;
          });
        }
        return;
      }

      const seen = metaVersionsRef.current.get(sessionId) ?? 0;
      if (state.version < seen) return;
      metaVersionsRef.current.set(sessionId, state.version);
      applyMetaStateSnapshot(state);
    };

    const handleMetaEvent = (payload: { sessionId: string; version: number } & Record<string, unknown>) => {
      // Update the sidebar pending-question badge for ANY session's meta event,
      // not just the active one.  Background sessions emit pendingQuestion
      // and pendingPlan updates into their own meta rooms; the badge must
      // reflect all of them.
      if (Object.prototype.hasOwnProperty.call(payload, "pendingQuestion") ||
          Object.prototype.hasOwnProperty.call(payload, "pendingPlan")) {
        setSessionsAwaitingInput((prev) => {
          const next = new Set(prev);
          if (payload.pendingQuestion || payload.pendingPlan) {
            next.add(payload.sessionId);
          } else {
            next.delete(payload.sessionId);
          }
          return next;
        });
      }

      // Track compaction state for ANY session's meta event (same pattern as
      // sessionsAwaitingInput above) so the sidebar shows the yellow chase
      // indicator even for background sessions.
      if (payload.type === "compact_started" || payload.type === "compact_ended") {
        setSessionsCompacting((prev) => {
          const next = new Set(prev);
          if (payload.type === "compact_started") {
            next.add(payload.sessionId);
          } else {
            next.delete(payload.sessionId);
          }
          return next;
        });
      }

      const currentSessionId = activeSessionRef.current;
      if (payload.sessionId !== currentSessionId) return;
      const { sessionId, version, ...event } = payload;
      const seen = metaVersionsRef.current.get(sessionId) ?? 0;
      if (version <= seen) return;
      metaVersionsRef.current.set(sessionId, version);
      if (isMetaRelayEvent(event)) {
        applyMetaPatch(metaEventToStatePatch(event));
        if (event.type === "mcp_startup_report" && event.report) {
          // Buffer if session not yet hydrated — the new slim CLI no longer retries
          // in heartbeats, so without this the report would be lost for live events
          // that race session_active delivery.
          if (sessionHydratedRef.current) {
            applyMcpReport(event.report);
          } else {
            pendingMcpReportRef.current = event.report as Record<string, unknown>;
          }
        }
      }
    };

    // Re-subscribe to ALL meta rooms after non-recovered reconnects (e.g., server
    // restart). Without this, the client stops receiving meta_event updates until
    // the user switches sessions or reloads.
    // Also clear stored meta versions so the first state_snapshot/meta_event
    // arriving after reconnect is not dropped as "stale" — the server resets its
    // version counter to 0 on restart, so any previously-seen version would cause
    // all new events to be silently ignored.
    const handleReconnect = () => {
      metaVersionsRef.current.clear();
      prevMetaSessionRef.current = null;
      backgroundMetaIdsRef.current.clear();
      confirmedMetaLiveSessionIdsRef.current = new Set();
      setMetaInventoryVersion((version) => version + 1);
      void checkVersionCompatibility();
    };

    socket.on("state_snapshot", handleStateSnapshot);
    socket.on("meta_event", handleMetaEvent);
    socket.on("connect", handleReconnect);

    return () => {
      socket.off("state_snapshot", handleStateSnapshot);
      socket.off("meta_event", handleMetaEvent);
      socket.off("connect", handleReconnect);
      socket.disconnect();
      hubSocketRef.current = null;
      setHubSocket(null);
    };
  }, [applyMetaStateSnapshot, applyMetaPatch, applyMcpReport, checkVersionCompatibility]);

  React.useEffect(() => {
    const hubSock = hubSocketRef.current;
    if (!hubSock) return;

    const { activeSessionId: confirmedActiveSessionId } = getConfirmedMetaSubscriptionTargets({
      liveSessionIds: liveSessions.map((s) => s.sessionId),
      confirmedLiveSessionIds: confirmedMetaLiveSessionIdsRef.current,
      activeSessionId,
    });
    const prevId = prevMetaSessionRef.current;

    if (prevId && prevId !== confirmedActiveSessionId) {
      hubSock.emit("unsubscribe_session_meta", { sessionId: prevId });
      metaVersionsRef.current.delete(prevId);
    }

    if (confirmedActiveSessionId) {
      if (prevId !== confirmedActiveSessionId) {
        hubSock.emit("subscribe_session_meta", { sessionId: confirmedActiveSessionId });
      }
      prevMetaSessionRef.current = confirmedActiveSessionId;
    } else {
      prevMetaSessionRef.current = null;
    }
  }, [hubSocket, activeSessionId, liveSessions, metaInventoryVersion]);

  // Subscribe to meta rooms for ALL live sessions (not just the active one) so
  // that background sessions can update the sidebar pending-question badge.
  // The active session's subscription is managed by the effect above; this
  // effect handles every other live session.
  const backgroundMetaIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const hubSock = hubSocketRef.current;
    if (!hubSock) return;

    const { backgroundSessionIds } = getConfirmedMetaSubscriptionTargets({
      liveSessionIds: liveSessions.map((s) => s.sessionId),
      confirmedLiveSessionIds: confirmedMetaLiveSessionIdsRef.current,
      activeSessionId,
    });
    const currentIds = new Set(backgroundSessionIds);
    const prev = backgroundMetaIdsRef.current;

    // Unsubscribe from sessions that are no longer in the live list.
    // Do NOT unsubscribe the active session — it may have just been promoted
    // from background and its subscription is now managed by the active-session
    // effect above. Emitting unsubscribe here would silently break all meta
    // updates for the newly-opened session.
    for (const id of prev) {
      if (!currentIds.has(id)) {
        if (id !== activeSessionId) {
          hubSock.emit("unsubscribe_session_meta", { sessionId: id });
        }
        prev.delete(id);
      }
    }

    // Subscribe to newly-appeared background sessions.
    for (const id of currentIds) {
      if (!prev.has(id)) {
        hubSock.emit("subscribe_session_meta", { sessionId: id });
        prev.add(id);
      }
    }
  }, [hubSocket, liveSessions, activeSessionId, metaInventoryVersion]);

  const openSession = React.useCallback((relaySessionId: string) => {
    // Already viewing this session — nothing to do.
    if (relaySessionId === activeSessionRef.current) return;

    // Flush/cancel any pending RAF queues (streaming deltas & tool-stream
    // partials) from the previous session so they can't leak into the new one.
    cancelPendingDeltas();

    // Stop any in-flight haptics from the previous session immediately.
    cancelHaptic();

    // Determine if this is a same-runner switch so we can preserve runner-level
    // state (availableModels, availableCommands, providerUsage, authSource).
    // These values are runner-scoped, not session-scoped — resetting them on
    // same-runner switches causes a flash to empty and unnecessary re-renders
    // in the header / model selector.
    const sessions = liveSessionsRef.current;
    const prevSessionId = activeSessionRef.current;
    const prevRunnerId = prevSessionId
      ? sessions.find((s) => s.sessionId === prevSessionId)?.runnerId ?? null
      : null;
    const nextRunnerId = sessions.find((s) => s.sessionId === relaySessionId)?.runnerId ?? null;
    const sameRunner = !!(prevRunnerId && nextRunnerId && prevRunnerId === nextRunnerId);
    const prevViewerSocket = viewerWsRef.current;
    const nextGeneration = ++viewerSwitchGenerationRef.current;

    localStorage.setItem("pp.lastSessionId", relaySessionId);
    activeSessionRef.current = relaySessionId;
    lastSeqRef.current = null;
    lastViewerEventAtRef.current = Date.now(); // treat open as an "event" so we don't fire immediately
    awaitingSnapshotRef.current = true;
    renderedMcpReportTsRef.current = null;
    sessionHydratedRef.current = false;
    pendingMcpReportRef.current = null;
    chunkedDeliveryRef.current = null;
    lastCompletedSnapshotRef.current = null;
    injectedMessagesRef.current = [];
    setActiveSessionId(relaySessionId);
    setViewerStatus("Connecting…");
    setRetryState(null);
    setActiveToolCalls(new Map());
    setMcpOAuthPastes([]);
    setIsChangingModel(false);
    setUsageRefreshing(false);
    setResumeSessions([]);
    setResumeSessionsLoading(false);

    const cached = sessionUiCacheRef.current.get(relaySessionId);
    touchSessionCache(sessionUiCacheRef.current, relaySessionId);

    // ── Session-scoped state: always reset from cache or defaults ────────
    setMessages(cached?.messages ?? []);
    setActiveModel(cached?.activeModel ?? null);
    setSessionName(cached?.sessionName ?? null);
    setAgentActive(cached?.agentActive ?? false);
    setIsCompacting(cached?.isCompacting ?? false);
    setEffortLevel(cached?.effortLevel ?? null);
    setPlanModeEnabled(cached?.planModeEnabled ?? false);
    setAuthSource(cached?.authSource ?? null);
    setWorkerType(cached?.workerType ?? "pi");
    setTokenUsage(cached?.tokenUsage ?? null);
    setLastHeartbeatAt(cached?.lastHeartbeatAt ?? null);
    setTodoList(cached?.todoList ?? []);

    // ── Runner-scoped state: preserve on same-runner switch ─────────────
    if (!sameRunner) {
      setAvailableModels(cached?.availableModels ?? []);
      setAvailableCommands(cached?.availableCommands ?? []);
      setAuthSource(cached?.authSource ?? null);
      setProviderUsage(cached?.providerUsage ?? null);
    }

    // Don't restore pendingQuestion/pendingPlan from cache — the cache can be
    // stale if the user answered/rejected before the next heartbeat arrived.
    // The heartbeat (which arrives within seconds) will restore them with
    // authoritative values from the runner.
    setPendingQuestion(null);
    setPendingPlan(null);
    setPendingPermission(null);

    let socket = viewerWsRef.current;
    if (!socket) {
      socket = io("/viewer", {
        auth: {
          protocolVersion: SOCKET_PROTOCOL_VERSION,
          clientVersion: UI_VERSION,
        },
        withCredentials: true,
        autoConnect: false,
      });
      viewerWsRef.current = socket;
      attachServiceAnnounceListener(socket);
      if (sameRunner) {
        seedServiceCache(socket, prevViewerSocket);
      }
      setViewerSocket(socket);
      const nextSocket = socket;

      // Stale-connection watchdog: if the socket thinks it's connected but
      // no event has arrived for STALE_THRESHOLD_MS, force a reconnect.
      staleCheckTimerRef.current = setInterval(() => {
        if (!activeSessionRef.current) return;
        if (!nextSocket.connected) return;
        const elapsed = Date.now() - lastViewerEventAtRef.current;
        if (elapsed > STALE_THRESHOLD_MS) {
          log.warn(`Stale connection detected (${Math.round(elapsed / 1000)}s since last event). Reconnecting…`);
          nextSocket.disconnect();
          nextSocket.connect();
        }
      }, STALE_CHECK_INTERVAL_MS);

      nextSocket.on("connect", () => {
        const currentSessionId = activeSessionRef.current;
        if (!currentSessionId) return;
        setViewerStatus("Connecting…");
        setViewerSwitchGeneration(nextSocket, viewerSwitchGenerationRef.current);
        nextSocket.emit("switch_session", {
          sessionId: currentSessionId,
          generation: viewerSwitchGenerationRef.current,
        });
      });

      nextSocket.on("connected", (data) => {
        if (!isActiveViewerSessionPayload(
          activeSessionRef.current,
          data.sessionId,
          viewerSwitchGenerationRef.current,
          data.generation,
        )) {
          return;
        }
        lastViewerEventAtRef.current = Date.now();

        const replayOnly = data.replayOnly === true;
        setViewerStatus(replayOnly ? "Snapshot replay" : "Connected");

        if (typeof data.lastSeq === "number") {
          lastSeqRef.current = mergeConnectedSeq(lastSeqRef.current, data.lastSeq);
        }

        if (typeof data.isActive === "boolean") {
          setAgentActive(data.isActive);
          patchSessionCache({ agentActive: data.isActive });
        }

        if (Object.prototype.hasOwnProperty.call(data, "sessionName")) {
          const nextName = normalizeSessionName(data.sessionName);
          setSessionName(nextName);
          patchSessionCache({ sessionName: nextName });
        }

        nextSocket.emit("connected", {});
      });

      nextSocket.on("event", (data) => {
        if (!matchesViewerGeneration(viewerSwitchGenerationRef.current, data.generation)) {
          return;
        }
        if (!activeSessionRef.current) return;
        lastViewerEventAtRef.current = Date.now();

        const rawEvent = data.event;
        const eventType =
          rawEvent && typeof rawEvent === "object" && typeof (rawEvent as Record<string, unknown>).type === "string"
            ? (rawEvent as Record<string, unknown>).type as string
            : "";

        if (shouldDeferEventForHydration(
          eventType,
          awaitingSnapshotRef.current,
          !!chunkedDeliveryRef.current,
        )) {
          return;
        }

        const seq = typeof data.seq === "number" ? data.seq : null;
        if (seq !== null) {
          const decision = analyzeIncomingSeq(lastSeqRef.current, seq);
          if (!decision.accept) {
            return;
          }
          if (decision.gap && decision.expected !== null) {
            log.warn(`Sequence gap: expected ${decision.expected}, got ${seq}. Requesting resync.`);
            nextSocket.emit("resync", {});
          }
          lastSeqRef.current = decision.nextSeq;
        }

        handleRelayEvent(data.event, seq ?? undefined);
      });

      nextSocket.on("exec_result", (data) => {
        if (!activeSessionRef.current) return;
        lastViewerEventAtRef.current = Date.now();
        handleRelayEvent({ type: "exec_result", ...data });
      });

      nextSocket.on("disconnected", (data) => {
        if (!matchesViewerGeneration(viewerSwitchGenerationRef.current, data.generation)) {
          return;
        }
        const currentSessionId = activeSessionRef.current;
        if (!currentSessionId) return;
        lastViewerEventAtRef.current = Date.now();
        if (data.reason === "Session reconnected" && restartPendingSessionIdRef.current !== currentSessionId) {
          restartPendingSessionIdRef.current = currentSessionId;
          if (restartPendingTimerRef.current) clearTimeout(restartPendingTimerRef.current);
          restartPendingTimerRef.current = setTimeout(() => {
            restartPendingSessionIdRef.current = null;
            restartPendingTimerRef.current = null;
          }, 60_000);
        }
        const isRestarting = restartPendingSessionIdRef.current === currentSessionId;
        if (!isRestarting) {
          setViewerStatus(data.reason || "Disconnected");
        } else {
          setViewerStatus("Restarting CLI…");
        }
        setPendingQuestion(null);
        setPendingPlan(null);
        setIsChangingModel(false);

        if (shouldStopViewerReconnect(data)) {
          nextSocket.disconnect();
        }
      });

      nextSocket.on("error", (data) => {
        if (!matchesViewerGeneration(viewerSwitchGenerationRef.current, data.generation)) {
          return;
        }
        if (!activeSessionRef.current) return;
        lastViewerEventAtRef.current = Date.now();
        const mapped = mapUserError({
          error: data.message,
          context: "viewer_connection",
          fallbackMessage: "Failed to load session.",
        });
        console.error("Viewer socket error:", mapped.technicalMessage, data);
        setViewerStatus(mapped.userMessage);
      });

      nextSocket.on("connect_error", (err) => {
        if (activeSessionRef.current) {
          const mapped = mapUserError({
            error: err,
            context: "viewer_connection",
          });
          console.error("Viewer socket connect_error:", err);
          setViewerStatus(mapped.userMessage);
        }
      });

      nextSocket.on("disconnect", (reason) => {
        if (activeSessionRef.current) {
          const isRestarting = restartPendingSessionIdRef.current === activeSessionRef.current;
          setViewerStatus((prev) =>
            isRestarting
              ? "Restarting CLI…"
              : prev === "Connected" || prev === "Connecting…"
                ? "Disconnected"
                : prev,
          );
          setPendingQuestion(null);
          setPendingPlan(null);
          setIsChangingModel(false);
          lastViewerEventAtRef.current = Date.now();

          if (reason === "io server disconnect") {
            setTimeout(() => {
              if (activeSessionRef.current && !nextSocket.connected) {
                nextSocket.connect();
              }
            }, 2000);
          }
        }
      });
    }

    if (!socket) return;

    setViewerSwitchGeneration(socket, nextGeneration);
    if (socket.connected) {
      socket.emit("switch_session", { sessionId: relaySessionId, generation: nextGeneration });
    } else {
      socket.connect();
    }
  }, [handleRelayEvent, patchSessionCache, cancelPendingDeltas]);

  // Auto-reopen the last viewed session once live sessions arrive.
  // Deep-links (/session/<id>) take priority over the stored lastSessionId.
  React.useEffect(() => {
    if (restoredRef.current) return;
    if (liveSessions.length === 0) return;

    // Prefer the deep-link session ID from the URL over the stored last session.
    const deepLinkId = deepLinkSessionIdRef.current;
    const targetId = deepLinkId ?? localStorage.getItem("pp.lastSessionId");
    if (!targetId) return;
    const still_live = liveSessions.some((s) => s.sessionId === targetId);
    if (!still_live) return;

    restoredRef.current = true;
    // Clear the deep-link ref so it doesn't interfere with future navigation,
    // and replace the URL so a reload doesn't re-trigger the deep-link.
    if (deepLinkId) {
      deepLinkSessionIdRef.current = null;
      history.replaceState(null, "", "/");
    }
    openSession(targetId);
  }, [liveSessions, openSession]);

  // When a restarted session comes back live, automatically reconnect to it.
  React.useEffect(() => {
    const pendingId = restartPendingSessionIdRef.current;
    if (!pendingId) return;
    const isLive = liveSessions.some((s) => s.sessionId === pendingId);
    if (!isLive) return;

    // Clear the pending restart state before reconnecting.
    restartPendingSessionIdRef.current = null;
    if (restartPendingTimerRef.current) {
      clearTimeout(restartPendingTimerRef.current);
      restartPendingTimerRef.current = null;
    }

    openSession(pendingId);
  }, [liveSessions, openSession]);


  // Dedup guard: prevent sending the exact same message text within a short window.
  const inputDedupeRef = React.useRef<InputDedupeState | null>(null);
  const inputAttemptIdRef = React.useRef(0);

  const sendSessionInput = React.useCallback(async (message: { text: string; files?: Array<{ file?: File; mediaType?: string; filename?: string; url?: string }>; deliverAs?: "steer" | "followUp" } | string) => {
    const socket = viewerWsRef.current;
    const sessionId = activeSessionRef.current;
    if (!socket || !socket.connected || !sessionId) {
      setViewerStatus("Not connected to a live session");
      return false;
    }

    const payload = typeof message === "string" ? { text: message, files: [] } : message;
    const trimmed = payload.text.trim();

    // Dedup guard: skip if the same text was sent/started in the last 500ms.
    const now = Date.now();
    if (shouldDeduplicateInput(inputDedupeRef.current, trimmed, now, 500)) {
      return true; // silently deduplicate
    }

    let attemptId: number | null = null;
    if (trimmed) {
      attemptId = ++inputAttemptIdRef.current;
      inputDedupeRef.current = beginInputAttempt(trimmed, now, attemptId);
    }

    const failCurrentAttempt = () => {
      if (attemptId === null) return;
      inputDedupeRef.current = failInputAttempt(inputDedupeRef.current, attemptId);
    };

    const rawFiles = (payload.files ?? [])
      .filter((f) => typeof f?.url === "string" && f.url.length > 0)
      .map((f) => ({
        file: f.file instanceof File ? f.file : undefined,
        mediaType: typeof f.mediaType === "string" ? f.mediaType : undefined,
        filename: typeof f.filename === "string" ? f.filename : undefined,
        url: f.url as string,
      }));

    let attachments: Array<{ attachmentId: string; filename?: string; mediaType?: string; size?: number; expiresAt?: string }> = [];

    if (rawFiles.length > 0) {
      const uploaded: Array<{ attachmentId: string; filename?: string; mediaType?: string; size?: number; expiresAt?: string }> = [];

      for (const [index, file] of rawFiles.entries()) {
        const displayName = file.filename || `attachment-${index + 1}`;
        setViewerStatus(`Uploading attachment ${index + 1}/${rawFiles.length}: ${displayName}`);

        const formData = new FormData();
        try {
          const uploadFile = file.file
            ? new File([file.file], displayName, {
                type: file.mediaType || file.file.type || "application/octet-stream",
              })
            : await fetch(file.url)
                .then((res) => res.blob())
                .then(
                  (blob) =>
                    new File([blob], displayName, {
                      type: file.mediaType || blob.type || "application/octet-stream",
                    })
                );
          formData.append("files", uploadFile);
        } catch {
          setViewerStatus(`Failed to prepare attachment: ${displayName}`);
          failCurrentAttempt();
          return false;
        }

        try {
          const uploadRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
            method: "POST",
            body: formData,
            credentials: "include",
          });

          if (!uploadRes.ok) {
            const body = await uploadRes.json().catch(() => null);
            const message = body && typeof body.error === "string" ? body.error : `Upload failed for ${displayName}`;
            setViewerStatus(message);
            failCurrentAttempt();
            return false;
          }

          const body = await uploadRes.json().catch(() => null) as any;
          const first = Array.isArray(body?.attachments) ? body.attachments[0] : null;
          if (!first || typeof first.attachmentId !== "string") {
            setViewerStatus(`Upload failed for ${displayName}`);
            failCurrentAttempt();
            return false;
          }

          uploaded.push({
            attachmentId: first.attachmentId as string,
            filename: typeof first.filename === "string" ? first.filename : undefined,
            mediaType: typeof first.mimeType === "string" ? first.mimeType : undefined,
            size: typeof first.size === "number" ? first.size : undefined,
            expiresAt: typeof first.expiresAt === "string" ? first.expiresAt : undefined,
          });
        } catch {
          setViewerStatus(`Upload failed for ${displayName}`);
          failCurrentAttempt();
          return false;
        }
      }

      attachments = uploaded;
      setViewerStatus(`Uploaded ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}. Sending…`);
    }

    const deliverAs = typeof message === "object" ? message.deliverAs : undefined;

    try {
      socket.emit("input", {
        text: trimmed,
        attachments,
        client: "web",
        ...(deliverAs ? { deliverAs } : {}),
      });

      // Mark dedupe as sent only after successful emit.
      if (attemptId !== null) {
        inputDedupeRef.current = completeInputAttempt(inputDedupeRef.current, attemptId, Date.now());
      }

      // Track queued messages when the agent is active
      if (deliverAs && trimmed) {
        if (deliverAs === "steer") {
          // Steer messages appear immediately in the conversation
          const now = Date.now();
          const optimisticSteerMessage: RelayMessage = {
            key: `user:steer:${now}:${Math.random().toString(16).slice(2)}`,
            role: "user",
            timestamp: now,
            content: trimmed,
          };
          const next = [...messagesRef.current, optimisticSteerMessage];
          setMessages(next);
          patchSessionCache({ messages: next });
          setViewerStatus("Steering message sent");
        } else {
          setMessageQueue((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              text: trimmed,
              deliverAs,
              timestamp: Date.now(),
            },
          ]);
          setViewerStatus("Follow-up queued");
        }
      } else {
        setViewerStatus("Connected");
      }
      return true;
    } catch {
      setViewerStatus("Failed to send message");
      failCurrentAttempt();
      return false;
    }
  }, [patchSessionCache]);

  const sendRemoteExec = React.useCallback((payload: any) => {
    const socket = viewerWsRef.current;
    if (!socket || !socket.connected || !activeSessionRef.current) {
      setViewerStatus("Not connected to a live session");
      return false;
    }
    const command = payload && typeof payload === "object" && typeof payload.command === "string" ? payload.command : null;
    if (command === "end_session") {
      setViewerStatus("Ending session…");
    } else if (command === "compact") {
      setViewerStatus("Compacting…");
    } else if (command === "abort") {
      // Optimistically mark as inactive so the UI updates immediately
      // instead of waiting for the next heartbeat cycle.
      setAgentActive(false);
      patchSessionCache({ agentActive: false });
      // Also update the sidebar's live session list so the session row
      // transitions from "active" to "completed unread" without waiting
      // for the hub's next session_status heartbeat.
      const sid = activeSessionRef.current;
      if (sid) {
        setLiveSessions((prev) =>
          prev.map((s) => (s.sessionId === sid ? { ...s, isActive: false } : s)),
        );
      }
    }
    try {
      const { type: _type, ...rest } = payload;
      socket.emit("exec", rest);
      return true;
    } catch {
      setViewerStatus("Failed to send command");
      return false;
    }
  }, []);

  /** Respond to a plugin trust prompt from the worker. */
  const respondPluginTrust = React.useCallback((trusted: boolean) => {
    const prompt = pluginTrustPrompt;
    if (!prompt) return;
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "plugin_trust_response",
      promptId: prompt.promptId,
      trusted,
    });
    // Only dismiss the banner if the send succeeded
    if (ok !== false) {
      setPluginTrustPrompt(null);
    }
  }, [sendRemoteExec, pluginTrustPrompt]);

  /** Respond to a permission request from the Claude Code worker. */
  const handlePermissionDecision = React.useCallback((requestId: string, decision: "allow" | "deny") => {
    setPendingPermission(null);
    sendRemoteExec({
      type: "exec",
      id: `permission-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "permission_response",
      requestId,
      decision,
    });
  }, [sendRemoteExec]);

  /**
   * End a session by session ID. If it's the currently active session the
   * existing viewer socket is used; otherwise a temporary socket is opened
   * for just the exec and then disconnected.
   */
  const handleEndSession = React.useCallback((sessionId: string) => {
    // Active session: reuse the existing viewer socket
    if (sessionId === activeSessionRef.current && viewerWsRef.current?.connected) {
      sendRemoteExec({
        type: "exec",
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: "end_session",
      });
      return;
    }

    // Non-active session: open a temporary viewer socket, fire the exec, disconnect.
    // We wait for the exec_result confirmation (or a generous timeout) instead of
    // blindly disconnecting after 500ms, which was too aggressive and caused the
    // exec to be dropped when the server was still processing.
    const tempSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> = io("/viewer", {
      auth: {
        sessionId,
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        clientVersion: UI_VERSION,
      },
      withCredentials: true,
    });

    const cleanup = () => tempSocket.disconnect();
    const timeout = setTimeout(cleanup, 10_000);

    tempSocket.on("connected", () => {
      clearTimeout(timeout);
      const execId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      // Listen for exec_result confirmation before disconnecting
      const resultTimeout = setTimeout(cleanup, 5_000); // fallback if no reply
      tempSocket.on("exec_result", (data) => {
        if (data && data.id === execId) {
          clearTimeout(resultTimeout);
          cleanup();
        }
      });

      tempSocket.emit("exec", {
        id: execId,
        command: "end_session",
      });
    });

    tempSocket.on("connect_error", () => {
      clearTimeout(timeout);
      cleanup();
    });
  }, [sendRemoteExec]);

  const requestResumeSessions = React.useCallback(() => {
    if (!activeSessionRef.current) return false;
    setResumeSessionsLoading(true);
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "list_resume_sessions",
    });
    if (!ok) {
      setResumeSessionsLoading(false);
    }
    return ok;
  }, [sendRemoteExec]);

  const refreshUsage = React.useCallback(() => {
    if (usageRefreshing) return false;
    setUsageRefreshing(true);
    setViewerStatus("Refreshing usage…");
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "refresh_usage",
    });
    if (!ok) {
      setUsageRefreshing(false);
    }
    return ok;
  }, [sendRemoteExec, usageRefreshing]);

  const removeQueuedMessage = React.useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const editQueuedMessage = React.useCallback((id: string, newText: string) => {
    setMessageQueue((prev) => prev.map((m) => m.id === id ? { ...m, text: newText } : m));
  }, []);

  const clearMessageQueue = React.useCallback(() => {
    setMessageQueue([]);
  }, []);

  const selectModel = React.useCallback((model: ConfiguredModelInfo) => {
    const socket = viewerWsRef.current;
    if (!socket || !socket.connected || !activeSessionRef.current) {
      setViewerStatus("Not connected to a live session");
      return;
    }

    try {
      setIsChangingModel(true);
      setViewerStatus(`Switching model to ${model.provider}/${model.id}…`);
      socket.emit("model_set", { provider: model.provider, modelId: model.id });
      setModelSelectorOpen(false);
    } catch {
      setIsChangingModel(false);
      setViewerStatus("Failed to change model");
    }
  }, []);

  const handleOpenSession = React.useCallback((id: string) => {
    setShowRunners(false);
    openSession(id);
    setSidebarOpen(false);
  }, [openSession]);

  // Listen for messages from the service worker (e.g. notification click → open session)
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "open-session" && typeof event.data.sessionId === "string") {
        handleOpenSession(event.data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [handleOpenSession]);

  const handleClearSelection = React.useCallback(() => {
    setShowRunners(false);
    clearSelection();
    setSidebarOpen(false);
  }, [clearSelection]);

  // Global keyboard shortcuts
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      const meta = isMac ? e.metaKey : e.ctrlKey;

      // ? — Show shortcuts help (only when not in an input)
      if (
        e.key === "?" &&
        !inInput &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !document.querySelector('[role="dialog"]')
      ) {
        setShowShortcutsHelp(true);
        return;
      }

      // Cmd/Ctrl + K — Focus the prompt textarea
      if (meta && !e.shiftKey && !e.altKey && e.key === "k") {
        e.preventDefault();
        document.querySelector<HTMLElement>("[data-pp-prompt]")?.focus();
        return;
      }

      // Ctrl + ` — Toggle terminal (Ctrl always, avoids macOS Cmd+` window-switch conflict)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "`") {
        e.preventDefault();
        setShowTerminal((v) => !v);
        return;
      }

      // Cmd/Ctrl + Shift + E — Toggle file explorer
      if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setShowFileExplorer((v) => !v);
        return;
      }

      // Cmd/Ctrl + . — Abort the active agent
      if (meta && !e.shiftKey && !e.altKey && e.key === ".") {
        e.preventDefault();
        if (agentActive && activeSessionRef.current) {
          sendRemoteExec({
            type: "exec",
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            command: "abort",
          });
        }
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac, agentActive, sendRemoteExec]);

  const handleNewSession = React.useCallback(() => {
    setSpawnRunnerId(undefined);
    setSpawnPreselectedRunnerId(null);
    setSpawnWorkerType("pi");
    setSpawnCwd("");
    setRecentFolders([]);
    setNewSessionOpen(true);
  }, []);

  const handleDuplicateSession = React.useCallback((runnerId: string, cwd: string, sourceWorkerType?: "pi" | "claude-code") => {
    setSpawnRunnerId(runnerId);
    setSpawnPreselectedRunnerId(runnerId);
    setSpawnWorkerType(sourceWorkerType ?? "pi");
    setSpawnCwd(cwd);
    setRecentFolders([]);
    setNewSessionOpen(true);
  }, []);

  // ── Session live waiter — resolves via /hub feed, no polling ──────────────
  const sessionWaitersRef = React.useRef<Map<string, {
    resolve: (found: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>(new Map());

  // Resolve any pending waiters when liveSessions updates
  React.useEffect(() => {
    for (const [sessionId, waiter] of sessionWaitersRef.current) {
      if (liveSessions.some(s => s.sessionId === sessionId)) {
        clearTimeout(waiter.timer);
        sessionWaitersRef.current.delete(sessionId);
        waiter.resolve(true);
      }
    }
  }, [liveSessions]);

  const waitForSessionToGoLive = React.useCallback(
    (sessionId: string, timeoutMs: number): Promise<boolean> => {
      // Fast path: already live
      if (liveSessions.some(s => s.sessionId === sessionId)) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          sessionWaitersRef.current.delete(sessionId);
          resolve(false);
        }, timeoutMs);
        sessionWaitersRef.current.set(sessionId, { resolve, timer });
      });
    },
    [liveSessions],
  );

  const spawnNewRunnerSession = React.useCallback(async () => {
    if (spawningSession) return;

    setSpawningSession(true);
    setViewerStatus("Spawning session…");

    if (!spawnRunnerId) {
      setViewerStatus("Pick a runner");
      setSpawningSession(false);
      return;
    }

    const payload: any = {
      runnerId: spawnRunnerId,
      ...(spawnCwd.trim() ? { cwd: spawnCwd.trim() } : {}),
      ...(spawnWorkerType !== "pi" ? { workerType: spawnWorkerType } : {}),
    };

    let sessionId: string | null = null;
    try {
      const res = await fetch("/api/runners/spawn", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => null) as { error?: string; sessionId?: string } | null;
      if (!res.ok) {
        const mapped = mapUserError({
          error: body?.error,
          statusCode: res.status,
          context: "session_spawn",
        });
        console.error("Failed to spawn session:", mapped.technicalMessage, body);
        setViewerStatus(mapped.userMessage);
        return;
      }

      sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      if (!sessionId) {
        const mapped = mapUserError({
          error: "Spawn failed: missing sessionId",
          context: "session_spawn",
        });
        console.error("Failed to spawn session:", mapped.technicalMessage, body);
        setViewerStatus(mapped.userMessage);
        return;
      }

      setNewSessionOpen(false);

      // Wait until the worker actually registers with the relay, otherwise opening the
      // viewer websocket would immediately fall back to snapshot replay and disconnect.
      const live = await waitForSessionToGoLive(sessionId, 30_000);
      if (!live) {
        setViewerStatus("Session is starting… (it will appear in the sidebar soon)");
        return;
      }

      handleOpenSession(sessionId);
      setViewerStatus("Connecting…");
    } catch (err) {
      const mapped = mapUserError({
        error: err,
        context: "session_spawn",
      });
      console.error("Failed to spawn session:", err);
      setViewerStatus(mapped.userMessage);
    } finally {
      setSpawningSession(false);
    }
  }, [spawningSession, spawnRunnerId, spawnWorkerType, spawnCwd, handleOpenSession, waitForSessionToGoLive]);

  /** Spawn handler for the new wizard dialog. */
  const handleWizardSpawn = React.useCallback(async (runnerId: string, cwd: string | undefined, workerType: "pi" | "claude-code" = "pi") => {
    setViewerStatus("Spawning session…");

    const payload: any = { runnerId, ...(cwd ? { cwd } : {}), ...(workerType !== "pi" ? { workerType } : {}) };
    const res = await fetch("/api/runners/spawn", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => null) as { error?: string; sessionId?: string } | null;
    if (!res.ok) {
      const mapped = mapUserError({
        error: body?.error,
        statusCode: res.status,
        context: "session_spawn",
      });
      console.error("Failed to spawn session from wizard:", mapped.technicalMessage, body);
      throw new Error(mapped.userMessage);
    }

    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
    if (!sessionId) {
      const mapped = mapUserError({
        error: "Spawn failed: missing sessionId",
        context: "session_spawn",
      });
      console.error("Spawn response missing sessionId:", mapped.technicalMessage, body);
      throw new Error(mapped.userMessage);
    }

    setNewSessionOpen(false);

    const live = await waitForSessionToGoLive(sessionId, 30_000);
    if (!live) {
      setViewerStatus("Session is starting… (it will appear in the sidebar soon)");
      return;
    }

    handleOpenSession(sessionId);
    setViewerStatus("Connecting…");
  }, [handleOpenSession, waitForSessionToGoLive]);

  // ── Respond to a trigger from a child session ─────────────────────────────
  const handleTriggerResponse = React.useCallback((triggerId: string, response: string, action?: string, sourceSessionId?: string): Promise<boolean> => {
    const socket = viewerWsRef.current;
    const sessionId = activeSessionRef.current;
    if (!socket || !socket.connected || !sessionId) {
      setViewerStatus("Not connected to a live session");
      return Promise.resolve(false);
    }

    // Use the child's sourceSessionId (extracted from the trigger comment) as
    // targetSessionId so the server can route directly to the child session,
    // bypassing the parent's in-memory receivedTriggers map. This makes
    // delivery resilient to parent reconnects/resumes where the map is gone.
    // Falls back to the parent session ID for legacy triggers without source.
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const settle = (success: boolean, message?: string) => {
        if (resolved) return;
        resolved = true;
        if (message) setViewerStatus(message);
        errorCleanup();
        resolve(success);
      };

      // Listen for trigger_error events — the server emits these immediately
      // when the target child is missing, unauthorized, or relay delivery fails.
      // Each error carries its triggerId so concurrent trigger submissions
      // don't interfere with each other (unlike the shared "error" event).
      const onTriggerError = (data: any) => {
        if (data?.triggerId === triggerId) {
          settle(false, "Trigger delivery failed — try again");
        }
      };
      socket.on("trigger_error", onTriggerError);
      const errorCleanup = () => { socket.off("trigger_error", onTriggerError); };

      // Send with Socket.IO ack — server only acks on successful delivery.
      socket.emit("trigger_response", {
        triggerId,
        response,
        ...(action ? { action } : {}),
        targetSessionId: sourceSessionId ?? sessionId,
      }, () => {
        // Server acknowledged successful delivery
        settle(true);
      });
      // If no ack arrives within 5s, treat as a failed delivery
      setTimeout(() => {
        settle(false, "Trigger response may not have been delivered — try again");
      }, 5000);
    });
  }, []);

  // ── Spawn a new session as a specific agent ─────────────────────────────
  const handleSpawnAgentSession = React.useCallback(async (agent: {
    name: string;
    description?: string;
    systemPrompt?: string;
    tools?: string;
    disallowedTools?: string;
  }) => {
    // Determine runner/cwd from the current active session
    const sessionInfo = activeSessionId
      ? liveSessions.find((s) => s.sessionId === activeSessionId)
      : null;
    const runnerId = sessionInfo?.runnerId;
    const cwd = sessionInfo?.cwd;

    if (!runnerId) {
      setViewerStatus("No runner available — open a session first");
      return;
    }

    setViewerStatus(`Spawning ${agent.name} agent session…`);

    try {
      const res = await fetch("/api/runners/spawn", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runnerId,
          ...(cwd ? { cwd } : {}),
          agent: {
            name: agent.name,
            ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
            ...(agent.tools ? { tools: agent.tools } : {}),
            ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
          },
        }),
      });

      const body = await res.json().catch(() => null) as { error?: string; sessionId?: string } | null;
      if (!res.ok) {
        const mapped = mapUserError({
          error: body?.error,
          statusCode: res.status,
          context: "session_spawn",
        });
        console.error("Failed to spawn agent session:", mapped.technicalMessage, body);
        setViewerStatus(mapped.userMessage);
        return;
      }

      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      if (!sessionId) {
        const mapped = mapUserError({
          error: "Spawn failed: missing sessionId",
          context: "session_spawn",
        });
        console.error("Agent spawn response missing sessionId:", mapped.technicalMessage, body);
        setViewerStatus(mapped.userMessage);
        return;
      }

      // Wait until the worker registers with the relay
      const live = await waitForSessionToGoLive(sessionId, 30_000);
      if (!live) {
        setViewerStatus("Agent session is starting… (it will appear in the sidebar soon)");
        return;
      }

      handleOpenSession(sessionId);
      setViewerStatus("Connecting…");
    } catch (err) {
      const mapped = mapUserError({
        error: err,
        context: "session_spawn",
      });
      console.error("Failed to spawn agent session:", err);
      setViewerStatus(mapped.userMessage);
    }
  }, [activeSessionId, liveSessions, handleOpenSession, waitForSessionToGoLive]);

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

  const activeRunnerInfo = React.useMemo(
    () => feedRunners.find(r => r.runnerId === activeSessionInfo?.runnerId) ?? null,
    [feedRunners, activeSessionInfo?.runnerId],
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
      if (liveSessions.some((s) => s.sessionId === cached)) return cached;
    }
    tunnelSessionMapRef.current.set(runnerId, activeSessionId);
    return activeSessionId;
  }, [activeSessionId, activeSessionInfo?.runnerId, liveSessions]);

  // Runner service panels — dynamically discovered
  const { services: availableServices, panels: dynamicPanels, triggerDefs: runnerTriggerDefs } = useRunnerServices(viewerSocket);
  const triggerCounts = useTriggerCount(activeSessionId, viewerSocket);
  const { activePanelIds: activeServicePanels, togglePanel: toggleServicePanel, closePanelById: closeServicePanelById, closeAllPanels: closeAllServicePanels, getPanelPosition: getServicePanelPosition, setPanelPosition: setServicePanelPosition, setEphemeralPanelPosition: setEphemeralServicePanelPosition } = useServicePanelState();

  // Auto-open Tunnel panel when a non-pinned tunnel is registered.
  React.useEffect(() => {
    if (!viewerSocket) return;
    const handler = (envelope: { serviceId: string; type: string; payload: unknown }) => {
      if (envelope.serviceId !== "tunnel" || envelope.type !== "tunnel_registered") return;
      const info = envelope.payload as { pinned?: boolean } | undefined;
      if (info?.pinned) return; // Don't auto-open for daemon-pinned panel ports
      // Open the Tunnel panel if not already open
      if (!activeServicePanels.has("tunnel")) {
        toggleServicePanel("tunnel");
      }
    };
    viewerSocket.on("service_message", handler);
    return () => { viewerSocket.off("service_message", handler); };
  }, [viewerSocket, activeServicePanels, toggleServicePanel]);

  const handleToggleServicePanel = React.useCallback((serviceId: string) => {
    if (activeServicePanels.has(serviceId)) {
      closeServicePanelById(serviceId);
    } else {
      // Resolve the correct position for the new panel using the shared pure
      // helper (also tested in ServicePanels.test.ts).  When the currently-
      // active tab is a service panel, the new panel inherits that panel's
      // position so both appear together rather than in separate dock groups.
      const newPosition = resolveNewPanelPosition(
        serviceId,
        combinedActiveTab,
        activeServicePanels,
        getServicePanelPosition,
      );
      if (activeServicePanels.has(combinedActiveTab)) {
        // Auto-placement: the position was derived from another panel, not from
        // this panel's own saved preference.  Store it as an ephemeral override
        // so it is used for rendering this session but does NOT overwrite the
        // panel's persisted dock preference in localStorage.
        setEphemeralServicePanelPosition(serviceId, newPosition);
      }
      // When the active tab is NOT a service panel, newPosition equals the
      // panel's own stored/default preference — no action needed, getPanelPosition
      // will already return the correct value.
      toggleServicePanel(serviceId);
      handleCombinedTabChange(serviceId);
    }
  }, [activeServicePanels, closeServicePanelById, toggleServicePanel, handleCombinedTabChange, combinedActiveTab, setEphemeralServicePanelPosition, getServicePanelPosition]);

  const terminalPanelTab = React.useMemo<CombinedPanelTab | null>(() => showTerminal ? {
    id: "terminal",
    label: "Terminal",
    icon: <TerminalIcon className="size-3.5" />,
    onClose: () => setShowTerminal(false),
    onDragStart: (e) => startPanelDragWith(e, handleTerminalPositionChange),
    content: (
      <TerminalManager
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
    ),
  } : null, [showTerminal, activeSessionId, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, feedRunners, liveSessions, runnersStatus, terminalTabs, activeTerminalId, setActiveTerminalId, handleTerminalTabAdd, handleTerminalTabClose, startPanelDragWith, handleTerminalPositionChange]);

  const filesPanelTab = React.useMemo<CombinedPanelTab | null>(() => (showFileExplorer && activeSessionInfo?.runnerId && activeSessionInfo?.cwd) ? {
    id: "files",
    label: "Files",
    icon: <FolderTree className="size-3.5" />,
    onClose: () => setShowFileExplorer(false),
    onDragStart: (e) => startPanelDragWith(e, handleFilesPositionChange),
    content: (
      <FileExplorer
        runnerId={activeSessionInfo.runnerId}
        cwd={activeSessionInfo.cwd}
        className="h-full"
      />
    ),
  } : null, [showFileExplorer, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, startPanelDragWith, handleFilesPositionChange]);

  const gitPanelTab = React.useMemo<CombinedPanelTab | null>(() => (showGit && activeSessionInfo?.runnerId && activeSessionInfo?.cwd) ? {
    id: "git",
    label: "Git",
    icon: <GitBranch className="size-3.5" />,
    onClose: () => setShowGit(false),
    onDragStart: (e) => startPanelDragWith(e, handleGitPositionChange),
    content: (
      <GitPanel
        cwd={activeSessionInfo.cwd}
      />
    ),
  } : null, [showGit, activeSessionInfo?.runnerId, activeSessionInfo?.cwd, startPanelDragWith, handleGitPositionChange]);

  const triggersPanelTab = React.useMemo<CombinedPanelTab | null>(() => (showTriggers && activeSessionId) ? {
    id: "triggers",
    label: "Triggers",
    icon: <Zap className="size-3.5" />,
    onClose: () => setShowTriggers(false),
    onDragStart: (e) => startPanelDragWith(e, handleTriggersPositionChange),
    content: (
      <TriggersPanel sessionId={activeSessionId} triggerDefs={runnerTriggerDefs} viewerSocket={viewerSocket} />
    ),
  } : null, [showTriggers, activeSessionId, runnerTriggerDefs, viewerSocket, startPanelDragWith, handleTriggersPositionChange, setShowTriggers]);

  const servicePanelTabs = React.useMemo<CombinedPanelTab[]>(() => {
    // Use tunnelSessionId (runner-stable) instead of activeSessionId so
    // iframe service panels don't reload on same-runner session switches.
    // The tunnel proxy resolves sessionId → runnerId, so any valid session
    // on the same runner reaches the same localhost ports.
    const effectiveSessionId = tunnelSessionId ?? activeSessionId;
    if (activeServicePanels.size === 0 || !effectiveSessionId) return [];

    const tabs: CombinedPanelTab[] = [];
    for (const serviceId of activeServicePanels) {
      // Try static registry first, then dynamic panels
      const staticDef = SERVICE_PANELS.find(p => p.serviceId === serviceId);
      const dynamicDef = !staticDef ? dynamicPanels.find(p => p.serviceId === serviceId) : null;
      if (!staticDef && !dynamicDef) continue;

      const label = staticDef?.label ?? dynamicDef!.label;
      const icon = staticDef?.icon ?? <DynamicLucideIcon name={dynamicDef!.icon} />;
      const content = staticDef
        ? <staticDef.component sessionId={effectiveSessionId} runnerId={activeSessionInfo?.runnerId ?? undefined} />
        : <IframeServicePanel sessionId={effectiveSessionId} port={dynamicDef!.port} />;

      tabs.push({
        id: serviceId,
        label,
        icon,
        onDragStart: (e) => startPanelDragWith(e, (pos) => {
          setServicePanelPosition(serviceId, pos);
          // Re-assert focus on the moved panel so the destination group
          // highlights it rather than falling back to tabs[0] (Tunnels).
          handleCombinedTabChange(serviceId);
        }),
        onClose: () => closeServicePanelById(serviceId),
        content,
      });
    }
    return tabs;
  }, [activeServicePanels, tunnelSessionId, activeSessionId, dynamicPanels, startPanelDragWith, setServicePanelPosition, closeServicePanelById, handleCombinedTabChange]);

  const panelGroups = React.useMemo(() => {
    type PG = import("@/hooks/usePanelLayout").PanelPosition;
    const groups: Record<PG, CombinedPanelTab[]> = {
      "left-top": [], "left-middle": [], "left-bottom": [],
      "center-top": [], "center-bottom": [],
      "right-top": [], "right-middle": [], "right-bottom": [],
    };
    if (terminalPanelTab) groups[terminalPosition].push(terminalPanelTab);
    if (filesPanelTab) groups[filesPosition].push(filesPanelTab);
    if (gitPanelTab) groups[gitPosition].push(gitPanelTab);
    if (triggersPanelTab) groups[triggersPosition].push(triggersPanelTab);
    for (const tab of servicePanelTabs) groups[getServicePanelPosition(tab.id)].push(tab);
    return groups;
  }, [terminalPanelTab, terminalPosition, filesPanelTab, filesPosition, gitPanelTab, gitPosition, triggersPanelTab, triggersPosition, servicePanelTabs, getServicePanelPosition]);

  // ── Derived column zone arrays ─────────────────────────────────────────────
  // Each side column orders its zones top→middle→bottom. Middle zone fills the
  // remaining vertical space; if absent, the first visible zone fills.
  const leftColZones = React.useMemo(() => {
    const candidates = [
      { pos: "left-top"    as const, tabs: panelGroups["left-top"],    storedHeight: leftTopHeight },
      { pos: "left-middle" as const, tabs: panelGroups["left-middle"],  storedHeight: 0 },
      { pos: "left-bottom" as const, tabs: panelGroups["left-bottom"],  storedHeight: leftBottomHeight },
    ].filter(z => z.tabs.length > 0);
    const midIdx = candidates.findIndex(z => z.pos === "left-middle");
    const fillIdx = midIdx >= 0 ? midIdx : 0;
    return candidates.map((z, i) => ({ ...z, fills: i === fillIdx }));
  }, [panelGroups, leftTopHeight, leftBottomHeight]);

  const rightColZones = React.useMemo(() => {
    const candidates = [
      { pos: "right-top"    as const, tabs: panelGroups["right-top"],    storedHeight: rightTopHeight },
      { pos: "right-middle" as const, tabs: panelGroups["right-middle"],  storedHeight: 0 },
      { pos: "right-bottom" as const, tabs: panelGroups["right-bottom"],  storedHeight: rightBottomHeight },
    ].filter(z => z.tabs.length > 0);
    const midIdx = candidates.findIndex(z => z.pos === "right-middle");
    const fillIdx = midIdx >= 0 ? midIdx : 0;
    return candidates.map((z, i) => ({ ...z, fills: i === fillIdx }));
  }, [panelGroups, rightTopHeight, rightBottomHeight]);

  const hasPanels = React.useMemo(() =>
    Object.values(panelGroups).some(g => g.length > 0),
  [panelGroups]);

  const centerTopTabs = panelGroups["center-top"];
  const centerBottomTabs = panelGroups["center-bottom"];
  const centerTopFullWidth = shouldCenterTopSpanFullWidth(panelGroups);
  const centerBottomFullWidth = shouldCenterBottomSpanFullWidth(panelGroups);

  const handleGroupPositionChange = React.useCallback((tabIds: string[], pos: import("@/hooks/usePanelLayout").PanelPosition) => {
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

  const getPanelGroupKey = React.useCallback((tabIds: string[]) => [...tabIds].sort().join("|"), []);
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
    return [terminalPanelTab, filesPanelTab, gitPanelTab, triggersPanelTab, ...servicePanelTabs].filter(Boolean) as CombinedPanelTab[];
  }, [terminalPanelTab, filesPanelTab, gitPanelTab, triggersPanelTab, servicePanelTabs]);

  const resolveActiveTabId = React.useCallback((tabs: CombinedPanelTab[]) => {
    return resolveActiveTabIdFromIds(tabs.map((t) => t.id), combinedActiveTab);
  }, [combinedActiveTab]);

  // Stable callbacks for memoized header components.
  //
  // Important: these hooks must stay ABOVE the auth/loading early returns
  // below. Moving them under `if (isPending)` / `if (!session)` changes the
  // number of hooks executed between renders and triggers React error #310
  // (“Rendered more hooks than during the previous render”).
  //
  // Keeping them here also preserves referential stability so React.memo can
  // skip re-rendering when only session-scoped state changes.
  const handleToggleDark = React.useCallback(() => setIsDark((d) => !d), []);
  const handleShowApiKeys = React.useCallback(() => { setShowApiKeys(true); setShowRunners(false); }, []);
  const handleShowRunners = React.useCallback(() => { setShowRunners(true); setShowApiKeys(false); activeSessionRef.current = null; setActiveSessionId(null); }, []);
  const handleShowShortcuts = React.useCallback(() => setShowShortcutsHelp(true), []);
  const handleShowHiddenModels = React.useCallback(() => setHiddenModelsOpen(true), []);
  const handleChangePassword = React.useCallback(() => setChangePasswordOpen(true), []);
  const handleToggleSidebar = React.useCallback(() => setSidebarOpen((prev) => !prev), []);
  // Mobile-specific variants that also close the sidebar
  const handleMobileShowApiKeys = React.useCallback(() => { setShowApiKeys(true); setShowRunners(false); setSidebarOpen(false); }, []);
  const handleMobileShowRunners = React.useCallback(() => { setShowRunners(true); setShowApiKeys(false); activeSessionRef.current = null; setActiveSessionId(null); setSidebarOpen(false); }, []);
  const handleMobileShowHiddenModels = React.useCallback(() => { setHiddenModelsOpen(true); setSidebarOpen(false); }, []);
  const handleMobileChangePassword = React.useCallback(() => { setChangePasswordOpen(true); setSidebarOpen(false); }, []);
  const handleSessionSwitcherOpenChange = React.useCallback((open: boolean) => setSessionSwitcherOpen(open), []);

  if (isPending) {
    return (
      <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background animate-in fade-in duration-300">
        <div className="border-b px-3 md:px-4 py-2 md:py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-24 rounded-md" />
              <Skeleton className="h-2.5 w-2.5 rounded-full" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-20 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="hidden md:flex md:w-72 border-r p-3 gap-3 flex-col">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </aside>
          <main className="flex min-h-0 flex-1 items-center justify-center px-4">
            <div className="flex flex-col items-center gap-3">
              <Spinner className="size-7 text-primary/60" />
              <span className="text-xs text-muted-foreground">Checking your session…</span>
            </div>
          </main>
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

  const activeModelKey = activeModel ? `${activeModel.provider}/${activeModel.id}` : "";
  const visibleModels = availableModels.filter(
    (m) => !hiddenModels.has(modelKey(m.provider, m.id))
  );
  const modelGroups = new Map<string, ConfiguredModelInfo[]>();
  for (const model of visibleModels) {
    if (!modelGroups.has(model.provider)) modelGroups.set(model.provider, []);
    modelGroups.get(model.provider)!.push(model);
  }

  return (
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
      <DegradedBanner relayStatus={relayStatus} />
      <RunnerWarningBanner runners={feedRunners} />
      <VersionBanner message={versionBanner.message} protocolCompatible={versionBanner.protocolCompatible} />
      {/* ── Desktop header (memoized — skips re-render on same-runner session switch) ── */}
      <DesktopHeader
        relayStatus={relayStatus}
        isDark={isDark}
        providerUsage={providerUsage}
        authSource={authSource}
        activeProvider={activeModel?.provider}
        usageRefreshing={usageRefreshing}
        userName={userName}
        userEmail={userEmail}
        userLabel={userLabel}
        onToggleDark={handleToggleDark}
        onShowApiKeys={handleShowApiKeys}
        onShowRunners={handleShowRunners}
        onShowShortcuts={handleShowShortcuts}
        onShowHiddenModels={handleShowHiddenModels}
        onChangePassword={handleChangePassword}
        onRefreshUsage={refreshUsage}
      />

      {/* ── Mobile header (memoized — skips re-render on same-runner session switch) ── */}
      <MobileHeader
        relayStatus={relayStatus}
        isDark={isDark}
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
        onToggleDark={handleToggleDark}
        onShowApiKeys={handleMobileShowApiKeys}
        onShowRunners={handleMobileShowRunners}
        onShowHiddenModels={handleMobileShowHiddenModels}
        onChangePassword={handleMobileChangePassword}
        onRefreshUsage={refreshUsage}
        onOpenSession={handleOpenSession}
        onNewSession={handleNewSession}
        onSessionSwitcherOpenChange={handleSessionSwitcherOpenChange}
      />
      {/* Spacer that reserves the exact height of the fixed mobile header */}
      <div className="md:hidden flex-shrink-0" style={{ height: "calc(3.25rem + env(safe-area-inset-top))" }} aria-hidden="true" />

      {/* Mobile model selector (shared with desktop) */}
      <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
        <div className="hidden" />
        <ModelSelectorContent
          className="sm:max-w-xl"
          defaultValue={activeModel ? `${activeModel.provider} ${activeModel.id} ${activeModel.name ?? ""}`.toLowerCase() : undefined}
        >
          <ModelSelectorInput placeholder="Search configured models…" />
          <ModelSelectorList className="max-h-[min(60dvh,400px)]">
            <ModelSelectorEmpty>
              {availableModels.length > 0 && visibleModels.length === 0
                ? "All models are hidden. Manage visibility in settings."
                : "No configured models available."}
            </ModelSelectorEmpty>
            {Array.from(modelGroups.entries()).map(([provider, models]) => (
              <ModelSelectorGroup key={provider} heading={provider}>
                {models.map((model) => {
                  const mk = `${model.provider}/${model.id}`;
                  const isActive = mk === activeModelKey;
                  return (
                    <ModelSelectorItem
                      key={mk}
                      value={`${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase()}
                      onSelect={() => selectModel(model)}
                    >
                      <ModelSelectorLogo provider={model.provider} />
                      <ModelSelectorName>
                        <span className="font-medium">{model.name || model.id}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{model.id}</span>
                      </ModelSelectorName>
                      {isActive && <ModelSelectorShortcut>Current</ModelSelectorShortcut>}
                    </ModelSelectorItem>
                  );
                })}
              </ModelSelectorGroup>
            ))}
            {/* Manage model visibility link */}
            {availableModels.length > 0 && (
              <div className="border-t px-2 py-2">
                <button
                  type="button"
                  onClick={() => { setModelSelectorOpen(false); setHiddenModelsOpen(true); }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  {hiddenModels.size > 0
                    ? `Manage model visibility (${hiddenModels.size} hidden)`
                    : "Manage model visibility"}
                </button>
              </div>
            )}
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>

      {/* Hidden models manager dialog */}
      <HiddenModelsManager
        open={hiddenModelsOpen}
        onOpenChange={setHiddenModelsOpen}
        models={availableModels}
        hiddenModels={hiddenModels}
        onHiddenModelsChange={setHiddenModels}
      />

      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
      />

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
              onClearSelection={handleClearSelection}
              onShowRunners={() => { setShowRunners(true); setShowApiKeys(false); activeSessionRef.current = null; setActiveSessionId(null); }}
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
          {centerTopFullWidth && (
            <div className="hidden md:flex flex-col shrink-0" style={{ height: centerTopCollapsed ? TAB_BAR_HEIGHT : centerTopHeight }}>
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
            {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
            {leftColZones.length > 0 && (
              <>
                <div className="hidden md:flex flex-col shrink-0 min-h-0" style={{ width: leftColumnWidth }}>
                  {leftColZones.map((zone, i) => {
                    const nextZone = leftColZones[i + 1];
                    const handleZonePos = nextZone
                      ? (zone.fills ? nextZone.pos : zone.pos)
                      : undefined;
                    const zoneTabIds = zone.tabs.map((t) => t.id);
                    const zoneCollapsed = isGroupCollapsed(zoneTabIds);
                    return (
                      <React.Fragment key={zone.pos}>
                        <div
                          className={cn(zoneCollapsed ? "shrink-0" : (zone.fills ? "flex-1 min-h-0" : "shrink-0"))}
                          style={zoneCollapsed
                            ? { height: TAB_BAR_HEIGHT }
                            : !zone.fills
                              ? { height: zone.storedHeight }
                              : undefined}
                        >
                          <DockedPanelGroup
                            position={zone.pos}
                            size={zone.storedHeight}
                            tabs={zone.tabs}
                            activeTabId={resolveActiveTabId(zone.tabs)}
                            onActiveTabChange={handleCombinedTabChange}
                            onPositionChange={(pos) => handleGroupPositionChange(zoneTabIds, pos)}
                            onDragStart={handleGroupDragStart(zoneTabIds)}
                            onResizeStart={() => {}}
                            collapsed={zoneCollapsed}
                            onCollapseChange={(next) => setGroupCollapsed(zoneTabIds, next)}
                            className="h-full w-full"
                          />
                        </div>
                        {nextZone && (
                          <div
                            className="hidden md:flex h-[5px] cursor-row-resize shrink-0 items-center justify-center group"
                            onPointerDown={handleZonePos ? (e) => startZoneHeightResize(handleZonePos, e) : undefined}
                          >
                            <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors w-full h-px" />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
                <div
                  className="hidden md:flex w-[5px] cursor-col-resize shrink-0 items-center justify-center group"
                  onPointerDown={(e) => startColumnWidthResize("left", e)}
                >
                  <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors h-full w-px" />
                </div>
              </>
            )}

            {/* ── CENTER COLUMN ───────────────────────────────────────────── */}
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
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

              <div id="main-content" tabIndex={-1} className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
                  {showRunners ? (
                    <RunnerManager
                      runners={feedRunners}
                      runnersStatus={runnersStatus}
                      sessions={liveSessions}
                      onOpenSession={(id) => { handleOpenSession(id); setShowRunners(false); }}
                      selectedRunnerId={selectedRunnerId}
                      onSelectRunner={setSelectedRunnerId}
                    />
                  ) : (
                    <ErrorBoundary level="section" resetKeys={[activeSessionId]}>
                      <SessionViewer
                        sessionId={activeSessionId}
                        sessionName={sessionName}
                        messages={messages}
                        activeModel={activeModel}
                        activeToolCalls={activeToolCalls}
                        pendingQuestion={pendingQuestion}
                        pendingPlan={pendingPlan}
                        pluginTrustPrompt={pluginTrustPrompt}
                        onPluginTrustResponse={respondPluginTrust}
                        availableCommands={availableCommands}
                        resumeSessions={resumeSessions}
                        resumeSessionsLoading={resumeSessionsLoading}
                        onRequestResumeSessions={requestResumeSessions}
                        onSendInput={sendSessionInput}
                        onExec={sendRemoteExec}
                        onShowModelSelector={() => setModelSelectorOpen(true)}
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
                        showTerminalButton
                        isTerminalOpen={showTerminal}
                        onToggleFileExplorer={() => setShowFileExplorer((v) => !v)}
                        showFileExplorerButton={!!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd}
                        isFileExplorerOpen={showFileExplorer}
                        onToggleGit={() => setShowGit((v) => !v)}
                        showGitButton={!!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd}
                        isGitOpen={showGit}
                        onToggleTriggers={() => setShowTriggers((v) => !v)}
                        showTriggersButton={!!activeSessionId}
                        isTriggersOpen={showTriggers}
                        triggerCount={triggerCounts}
                        extraHeaderButtons={
                          <ServicePanelButtons
                            availableServices={availableServices}
                            dynamicPanels={dynamicPanels}
                            activePanelIds={activeServicePanels}
                            onTogglePanel={handleToggleServicePanel}
                          />
                        }
                        todoList={todoList}
                        planModeEnabled={planModeEnabled}
                        runnerId={activeSessionInfo?.runnerId ?? undefined}
                        sessionCwd={activeSessionInfo?.cwd || undefined}
                        onAppendSystemMessage={appendLocalSystemMessage}
                        onSpawnAgentSession={handleSpawnAgentSession}
                        onTriggerResponse={handleTriggerResponse}
                        onQuestionDismiss={() => setPendingQuestion(null)}
                        onPlanDismiss={() => setPendingPlan(null)}
                        onDuplicateSession={activeSessionInfo?.runnerId ? () => handleDuplicateSession(activeSessionInfo.runnerId!, activeSessionInfo.cwd || "", workerType as "pi" | "claude-code") : undefined}
                        runnerInfo={activeRunnerInfo}
                        pendingPermission={pendingPermission}
                        onPermissionDecision={handlePermissionDecision}
                        workerType={workerType}
                        mcpOAuthPastes={mcpOAuthPastes}
                        onMcpOAuthPaste={(nonce, code, state) => {
                          const socket = viewerWsRef.current;
                          if (!socket?.connected) return Promise.resolve({ ok: false, error: "Not connected" });
                          return new Promise<{ ok: boolean; error?: string }>((resolve) => {
                            const timeout = setTimeout(() => resolve({ ok: false, error: "Delivery timed out" }), 5000);
                            socket.emit("mcp_oauth_paste", { nonce, code, state }, (result: any) => {
                              clearTimeout(timeout);
                              resolve(result && typeof result === "object" ? result : { ok: false, error: "Invalid response" });
                            });
                          });
                        }}
                        onMcpOAuthPasteDismiss={(serverName) => {
                          setMcpOAuthPastes((prev) => prev.filter((p) => p.serverName !== serverName));
                          const stableKey = `mcp_auth:${serverName}`;
                          injectedMessagesRef.current = injectedMessagesRef.current.filter(
                            (m) => m.key !== stableKey && !m.key.startsWith(`${stableKey}:`),
                          );
                          setMessages((prev) => {
                            const next = prev.filter((m) => m.key !== stableKey && !m.key.startsWith(`${stableKey}:`));
                            return next.length !== prev.length ? next : prev;
                          });
                        }}
                        onMcpServerDisable={(serverName) => {
                          setMcpOAuthPastes((prev) => prev.filter((p) => p.serverName !== serverName));
                          const stableKey = `mcp_auth:${serverName}`;
                          injectedMessagesRef.current = injectedMessagesRef.current.filter(
                            (m) => m.key !== stableKey && !m.key.startsWith(`${stableKey}:`),
                          );
                          const disableNext = messagesRef.current.filter(
                            (m) => m.key !== stableKey && !m.key.startsWith(`${stableKey}:`),
                          );
                          if (disableNext.length !== messagesRef.current.length) {
                            setMessages(disableNext);
                            patchSessionCache({ messages: disableNext });
                          }
                          const socket = viewerWsRef.current;
                          if (socket?.connected) {
                            socket.emit("exec", {
                              id: `disable-mcp-${serverName}-${Date.now()}`,
                              command: "mcp_toggle_server",
                              serverName,
                              disabled: true,
                            });
                          }
                        }}
                      />
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
                <div
                  className="hidden md:flex w-[5px] cursor-col-resize shrink-0 items-center justify-center group"
                  onPointerDown={(e) => startColumnWidthResize("right", e)}
                >
                  <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors h-full w-px" />
                </div>
                <div className="hidden md:flex flex-col shrink-0 min-h-0" style={{ width: rightColumnWidth }}>
                  {rightColZones.map((zone, i) => {
                    const nextZone = rightColZones[i + 1];
                    const handleZonePos = nextZone
                      ? (zone.fills ? nextZone.pos : zone.pos)
                      : undefined;
                    const zoneTabIds = zone.tabs.map((t) => t.id);
                    const zoneCollapsed = isGroupCollapsed(zoneTabIds);
                    return (
                      <React.Fragment key={zone.pos}>
                        <div
                          className={cn(zoneCollapsed ? "shrink-0" : (zone.fills ? "flex-1 min-h-0" : "shrink-0"))}
                          style={zoneCollapsed
                            ? { height: TAB_BAR_HEIGHT }
                            : !zone.fills
                              ? { height: zone.storedHeight }
                              : undefined}
                        >
                          <DockedPanelGroup
                            position={zone.pos}
                            size={zone.storedHeight}
                            tabs={zone.tabs}
                            activeTabId={resolveActiveTabId(zone.tabs)}
                            onActiveTabChange={handleCombinedTabChange}
                            onPositionChange={(pos) => handleGroupPositionChange(zoneTabIds, pos)}
                            onDragStart={handleGroupDragStart(zoneTabIds)}
                            onResizeStart={() => {}}
                            collapsed={zoneCollapsed}
                            onCollapseChange={(next) => setGroupCollapsed(zoneTabIds, next)}
                            className="h-full w-full"
                          />
                        </div>
                        {nextZone && (
                          <div
                            className="hidden md:flex h-[5px] cursor-row-resize shrink-0 items-center justify-center group"
                            onPointerDown={handleZonePos ? (e) => startZoneHeightResize(handleZonePos, e) : undefined}
                          >
                            <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors w-full h-px" />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {centerBottomFullWidth && (
            <div className="hidden md:flex flex-col shrink-0" style={{ height: centerBottomCollapsed ? TAB_BAR_HEIGHT : centerBottomHeight }}>
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

          {/* ── 3×3 DRAG OVERLAY ────────────────────────────────────────── */}
          {panelDragActive && (
            <div className="absolute inset-0 z-50 pointer-events-none hidden md:grid grid-cols-3 grid-rows-3">
              {([
                { pos: "left-top",      label: "Left\ntop"    },
                { pos: "center-top",    label: "Top"          },
                { pos: "right-top",     label: "Right\ntop"   },
                { pos: "left-middle",   label: "Left"         },
                { pos: null,            label: ""             },
                { pos: "right-middle",  label: "Right"        },
                { pos: "left-bottom",   label: "Left\nbottom" },
                { pos: "center-bottom", label: "Bottom"       },
                { pos: "right-bottom",  label: "Right\nbottom"},
              ] as const).map((zone, idx) => {
                if (zone.pos === null) {
                  return <div key={idx} />;
                }
                const isActive = panelDragZone === zone.pos;
                return (
                  <div
                    key={zone.pos}
                    className={cn(
                      "flex items-center justify-center border transition-colors duration-100",
                      isActive
                        ? "bg-blue-500/20 border-blue-500"
                        : "bg-zinc-900/40 border-zinc-700/30",
                    )}
                  >
                    <span className={cn(
                      "text-[10px] font-medium text-center transition-colors whitespace-pre-line leading-tight",
                      isActive ? "text-blue-300" : "text-zinc-600",
                    )}>
                      {zone.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <NewSessionWizardDialog
          open={newSessionOpen}
          onOpenChange={(open) => { if (!spawningSession) setNewSessionOpen(open); }}
          runners={feedRunners.map((r) => ({ ...r, name: r.name ?? null, isOnline: true, sessionCount: liveSessions.filter(s => s.runnerId === r.runnerId).length }))}
          runnersLoading={runnersStatus === "connecting"}
          preselectedRunnerId={spawnPreselectedRunnerId}
          initialCwd={spawnCwd}
          onSpawn={handleWizardSpawn}
        />

        {showApiKeys && (
          <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">API Keys</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setShowApiKeys(false)}
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex flex-col gap-4">
                <ApiKeyManager refreshSignal={apiKeyVersion} onKeysChanged={() => setApiKeyVersion((v) => v + 1)} />
                <RunnerTokenManager refreshSignal={apiKeyVersion} onKeysChanged={() => setApiKeyVersion((v) => v + 1)} />
              </div>
            </div>
          </div>
        )}

        <ShortcutsDialog open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp} />
      </div>
    </div>
    </TooltipProvider>
    </ViewerSocketContext.Provider>
    </HubSocketContext.Provider>
  );
}
