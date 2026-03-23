import * as React from "react";
import { SessionSidebar, type DotState, type HubSession } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import type { CommandResultData } from "@/components/session-viewer/rendering";
import { detectInFlightTools } from "@/components/session-viewer/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { RunnerTokenManager } from "@/components/RunnerTokenManager";
import { RunnerManager } from "@/components/RunnerManager";
import { NewSessionWizardDialog } from "@/components/NewSessionWizardDialog";
import { PizzaLogo } from "@/components/PizzaLogo";
import { authClient, useSession, signOut } from "@/lib/auth-client";
import { useRunnersFeed } from "@/lib/useRunnersFeed";
import { io, type Socket } from "socket.io-client";
import type {
  ViewerServerToClientEvents,
  ViewerClientToServerEvents,
  HubServerToClientEvents,
  HubClientToServerEvents,
  SessionMetaState,
} from "@pizzapi/protocol";
import { cn } from "@/lib/utils";
import { pulseStreamingHaptic, cancelHaptic, startToolHaptic, stopToolHaptic } from "@/lib/haptics";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sun, Moon, LogOut, KeyRound, X, User, ChevronsUpDown, PanelLeftOpen, HardDrive, Bell, BellOff, Check, Plus, TerminalIcon, FolderTree, Keyboard, EyeOff, Lock } from "lucide-react";
import { NotificationToggle, MobileNotificationMenuItem } from "@/components/NotificationToggle";
import { HapticsToggle, MobileHapticsMenuItem } from "@/components/HapticsToggle";
import { UsageIndicator, type ProviderUsageMap } from "@/components/UsageIndicator";
import { TerminalManager } from "@/components/TerminalManager";
import { FileExplorer } from "@/components/FileExplorer";
import { CombinedPanel } from "@/components/CombinedPanel";
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
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import {
  beginInputAttempt,
  completeInputAttempt,
  failInputAttempt,
  shouldDeduplicateInput,
  type InputDedupeState,
} from "@/lib/input-dedupe";
import { parsePendingQuestionDisplayMode, parsePendingQuestions, type QuestionDisplayMode } from "@/lib/ask-user-questions";
import type { TodoItem, TokenUsage, ConfiguredModelInfo, ResumeSessionOption, QueuedMessage, SessionUiCacheEntry } from "@/lib/types";
import { metaEventToStatePatch, type MetaStatePatch } from "@/lib/meta-state-apply";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { useMobileSidebar } from "@/hooks/useMobileSidebar";
import {
  toRelayMessage,
  deduplicateMessages,
  normalizeMessages,
  normalizeModel,
  normalizeSessionName,
  augmentThinkingDurations,
  normalizeModelList,
} from "@/lib/message-helpers";

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
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<RelayMessage[]>([]);
  const [viewerStatus, setViewerStatus] = React.useState("Idle");
  const [retryState, setRetryState] = React.useState<{ errorMessage: string; detectedAt: number } | null>(null);
  const [relayStatus, setRelayStatus] = React.useState<DotState>("connecting");
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
    const userId = session && typeof session === "object" ? (session as any).user?.id : null;
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
    terminalPosition, terminalHeight, terminalWidth, terminalColumnRef,
    handleTerminalResizeStart, handleTerminalPositionChange,
    panelDragActive, panelDragZone,
    handlePanelDragStart, handleTerminalTabDragStart,
    handleOuterPointerMove, handleOuterPointerUp,
    combinedActiveTab, handleCombinedTabChange, handleCombinedPositionChange,
    terminalTabs, activeTerminalId, setActiveTerminalId,
    handleTerminalTabAdd, handleTerminalTabClose,
    showFileExplorer, setShowFileExplorer,
    filesPosition, filesWidth, filesHeight, filesContainerRef,
    handleFilesWidthLeftResizeStart, handleFilesWidthRightResizeStart, handleFilesHeightResizeStart,
    handleFilesPositionChange,
    filesDragActive, filesDragZone, handleFilesDragStart,
    handleFilesOuterPointerMove, handleFilesOuterPointerUp,
  } = panelLayout;

  const [newSessionOpen, setNewSessionOpen] = React.useState(false);
  const [spawnRunnerId, setSpawnRunnerId] = React.useState<string | undefined>(undefined);
  const [spawnCwd, setSpawnCwd] = React.useState<string>("");
  const [spawnPreselectedRunnerId, setSpawnPreselectedRunnerId] = React.useState<string | null>(null);
  const [spawningSession, setSpawningSession] = React.useState(false);
  const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
  const [recentFoldersLoading, setRecentFoldersLoading] = React.useState(false);

  const [pendingQuestion, setPendingQuestion] = React.useState<{ toolCallId: string; questions: Array<{ question: string; options: string[]; type?: import("@/lib/ask-user-questions").QuestionType }>; display: QuestionDisplayMode } | null>(null);

  /** Pending plan mode prompt from the worker — shown as a plan review panel in the viewer. */
  const [pendingPlan, setPendingPlan] = React.useState<{
    toolCallId: string;
    title: string;
    description: string | null;
    steps: Array<{ title: string; description?: string }>;
  } | null>(null);

  /** Pending plugin trust prompt from the worker — shown as a confirmation dialog in the viewer. */
  const [pluginTrustPrompt, setPluginTrustPrompt] = React.useState<{
    promptId: string;
    pluginNames: string[];
    pluginSummaries: string[];
  } | null>(null);
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
  const [activeToolCalls, setActiveToolCalls] = React.useState<Map<string, string>>(new Map());

  // Message queue: messages sent while the agent is active
  const [messageQueue, setMessageQueue] = React.useState<QueuedMessage[]>([]);
  const [activeModel, setActiveModel] = React.useState<ConfiguredModelInfo | null>(null);
  const [sessionName, setSessionName] = React.useState<string | null>(null);
  const [availableModels, setAvailableModels] = React.useState<ConfiguredModelInfo[]>([]);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [isChangingModel, setIsChangingModel] = React.useState(false);
  const [hiddenModels, setHiddenModels] = React.useState<Set<string>>(() => loadHiddenModels());
  const [hiddenModelsOpen, setHiddenModelsOpen] = React.useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = React.useState(false);

  // Live session status from heartbeats
  const [agentActive, setAgentActive] = React.useState(false);
  const [isCompacting, setIsCompacting] = React.useState(false);
  const [effortLevel, setEffortLevel] = React.useState<string | null>(null);
  const [planModeEnabled, setPlanModeEnabled] = React.useState(false);
  const [tokenUsage, setTokenUsage] = React.useState<TokenUsage | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = React.useState<number | null>(null);
  const [providerUsage, setProviderUsage] = React.useState<ProviderUsageMap | null>(null);
  const [usageRefreshing, setUsageRefreshing] = React.useState(false);
  const [todoList, setTodoList] = React.useState<TodoItem[]>([]);
  const [authSource, setAuthSource] = React.useState<string | null>(null);

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

  // Tracks the highest meta state version seen per session, to prevent stale
  // state_snapshot from rolling back state already updated by meta_event.
  const metaVersionsRef = React.useRef<Map<string, number>>(new Map());

  // Tracks which session's meta room we've joined so we can unsubscribe when needed.
  const prevMetaSessionRef = React.useRef<string | null>(null);

  // Chunked session delivery: when session_active arrives with chunked:true,
  // messages follow as session_messages_chunk events. This ref tracks state.
  // The snapshotId ties chunks to their originating session_active so stale
  // chunks from a previous stream are discarded (e.g. if a new viewer
  // connects mid-stream and triggers a fresh emitSessionActive).
  const chunkedDeliveryRef = React.useRef<{
    snapshotId: string;
    totalMessages: number;
    totalChunks: number;
    receivedChunks: number;
    loadedMessages: number; // cumulative count for fallback key offset
  } | null>(null);

  // Track the last completed snapshot ID so we can reject stale chunks that
  // arrive after the ref has been cleared (e.g. from a superseded sender).
  const lastCompletedSnapshotRef = React.useRef<string | null>(null);

  // Capabilities advertised by the runner (commands, models, etc.)
  const [availableCommands, setAvailableCommands] = React.useState<Array<{ name: string; description?: string; source?: string }>>([]);

  // /resume picker state (fetched from runner session files)
  const [resumeSessions, setResumeSessions] = React.useState<ResumeSessionOption[]>([]);
  const [resumeSessionsLoading, setResumeSessionsLoading] = React.useState(false);

  // Mobile layout
  const {
    sidebarOpen, setSidebarOpen,
    sidebarSwipeOffset, suppressOverlayClickRef,
    handleSidebarPointerDown, handleSidebarPointerMove, handleSidebarPointerUp,
  } = useMobileSidebar();
  const [liveSessions, setLiveSessions] = React.useState<HubSession[]>([]);

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
  const hubSocketRef = React.useRef<Socket<HubServerToClientEvents, HubClientToServerEvents> | null>(null);
  const activeSessionRef = React.useRef<string | null>(null);

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
      ...patch,
    };

    sessionUiCacheRef.current.set(sessionId, next);
  }, []);

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
    return () => {
      if (staleCheckTimerRef.current !== null) {
        clearInterval(staleCheckTimerRef.current);
        staleCheckTimerRef.current = null;
      }
      viewerWsRef.current?.disconnect();
      viewerWsRef.current = null;
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
    setActiveSessionId(null);
    setMessages([]);
    setViewerStatus("Idle");
    setPendingQuestion(null);
    setPendingPlan(null);
    setPluginTrustPrompt(null);
    setRetryState(null);
    setActiveToolCalls(new Map());
    setMessageQueue([]);
    setActiveModel(null);
    setSessionName(null);
    setAvailableModels([]);
    setAvailableCommands([]);
    setResumeSessions([]);
    setResumeSessionsLoading(false);
    setModelSelectorOpen(false);
    setIsChangingModel(false);
    setAgentActive(false);
    setEffortLevel(null);
    setAuthSource(null);
    setTokenUsage(null);
    setProviderUsage(null);
    setUsageRefreshing(false);
    setLastHeartbeatAt(null);
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

    setMessages((prev) => {
      const next = [...prev, message];
      patchSessionCache({ messages: next });
      return next;
    });
  }, [patchSessionCache]);


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
    setMessages((prev) => {
      if (prev.some((m) => m.key?.startsWith(`mcp_startup:${reportTs}`))) return prev;
      const next = [...prev, message];
      patchSessionCache({ messages: next });
      return next;
    });
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
        const pp = patch.pendingPlan as any;
        if (typeof pp.toolCallId === "string" && typeof pp.title === "string") {
          const steps = Array.isArray(pp.steps)
            ? pp.steps.filter((s: any): s is { title: string; description?: string } =>
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
      };

      const nextAgentActive = hb.active === true;
      const nextIsCompacting = hb.isCompacting === true;
      const cachePatch: Partial<SessionUiCacheEntry> = {
        agentActive: nextAgentActive,
        isCompacting: nextIsCompacting,
      };

      setAgentActive(nextAgentActive);
      setIsCompacting(nextIsCompacting);

      if (nextIsCompacting) {
        setViewerStatus("Compacting…");
      } else {
        setViewerStatus((prev) => (prev === "Compacting…" ? "Connected" : prev));
      }

      if (typeof hb.ts === "number") {
        setLastHeartbeatAt(hb.ts);
        cachePatch.lastHeartbeatAt = hb.ts;
      }

      if (Object.prototype.hasOwnProperty.call(hb, "sessionName")) {
        const nextName = normalizeSessionName(hb.sessionName);
        setSessionName(nextName);
        cachePatch.sessionName = nextName;
      }

      if (hb.model) {
        const m = normalizeModel(hb.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      }

      if ((hb as any).mcpStartupReport && typeof (hb as any).mcpStartupReport === "object") {
        applyMcpReport((hb as any).mcpStartupReport);
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
      const modelsRaw = Array.isArray((evt as any).models) ? ((evt as any).models as unknown[]) : [];
      const commandsRaw = Array.isArray((evt as any).commands) ? ((evt as any).commands as any[]) : [];

      const normalizedModels = normalizeModelList(modelsRaw);
      const normalizedCommands = commandsRaw
        .filter((c) => c && typeof c === "object" && typeof c.name === "string")
        .map((c) => ({ name: String(c.name), description: typeof c.description === "string" ? c.description : undefined, source: typeof c.source === "string" ? c.source : undefined }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Keep model state in sync with capability snapshots too.
      setAvailableModels(normalizedModels);
      setAvailableCommands(normalizedCommands);
      patchSessionCache({ availableModels: normalizedModels, availableCommands: normalizedCommands });
      return;
    }

    if (type === "session_active") {
      const state = evt.state as Record<string, unknown> | undefined;
      const rawMessages = Array.isArray(state?.messages) ? (state?.messages as unknown[]) : [];
      const isChunked = !!(state as any)?.chunked;
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
      setMessages(normalizedMessages);
      setActiveModel(stateModel);
      if (hasSessionName) {
        setSessionName(nextSessionName);
      }
      setAvailableModels(stateModels);

      // Track chunked delivery state — messages arrive as subsequent
      // session_messages_chunk events when the session is large.
      if (isChunked) {
        const totalMessages = typeof (state as any)?.totalMessages === "number" ? (state as any).totalMessages : 0;
        const snapshotId = typeof (state as any)?.snapshotId === "string" ? (state as any).snapshotId : "";
        chunkedDeliveryRef.current = {
          snapshotId,
          totalMessages,
          totalChunks: 0, // updated as chunks arrive
          receivedChunks: 0,
          loadedMessages: 0,
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

      patchSessionCache({
        messages: normalizedMessages,
        activeModel: stateModel,
        ...(hasSessionName ? { sessionName: nextSessionName } : {}),
        availableModels: stateModels,
        effortLevel: thinkingLevel,
        todoList: stateTodos,
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

      const chunkSnapshotId = typeof (evt as any).snapshotId === "string" ? (evt as any).snapshotId : "";
      const chunkMessages = Array.isArray(evt.messages) ? evt.messages as unknown[] : [];
      const isFinal = !!(evt as any).final;
      const totalChunks = typeof (evt as any).totalChunks === "number" ? (evt as any).totalChunks : 0;
      const totalMessages = typeof (evt as any).totalMessages === "number" ? (evt as any).totalMessages : 0;

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

      const keyOffset = chunkedDeliveryRef.current?.loadedMessages ?? 0;
      // Convert messages but skip dedupe—we'll dedupe the full list when assembly completes.
      // This prevents cross-chunk duplicates where a partial message in one chunk and
      // its final timestamped version in another chunk would both survive per-chunk dedupe.
      const convertedChunk = chunkMessages
        .map((m, i) => toRelayMessage(m, `snapshot-${keyOffset + i}`))
        .filter((m): m is RelayMessage => m !== null);

      setMessages((prev) => [...prev, ...convertedChunk]);

      // Update chunked delivery tracking
      if (chunkedDeliveryRef.current) {
        chunkedDeliveryRef.current.receivedChunks++;
        chunkedDeliveryRef.current.loadedMessages += chunkMessages.length;
        chunkedDeliveryRef.current.totalChunks = totalChunks;
        const loaded = chunkedDeliveryRef.current.loadedMessages;
        setViewerStatus(`Loading session (${Math.min(loaded, totalMessages)} of ${totalMessages} messages)…`);
      }

      if (isFinal) {
        lastCompletedSnapshotRef.current = chunkSnapshotId || null;
        chunkedDeliveryRef.current = null;
        sessionHydratedRef.current = true;
        // Flush any MCP startup report that arrived before hydration completed
        if (pendingMcpReportRef.current) {
          applyMcpReport(pendingMcpReportRef.current);
          pendingMcpReportRef.current = null;
        }
        setViewerStatus("Connected");

        // Now that all messages are assembled, run global dedupe to remove
        // cross-chunk duplicates (e.g., partial messages from one chunk and
        // their final timestamped versions from another). This prevents
        // duplicate assistant/tool content from appearing in large-session reloads.
        setMessages((current) => {
          const deduped = deduplicateMessages(current);
          setActiveToolCalls(detectInFlightTools(deduped));
          patchSessionCache({ messages: deduped });
          return deduped;
        });
      }
      return;
    }

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      const normalized = normalizeMessages(evt.messages as unknown[]);
      cancelPendingDeltas();
      setMessages(normalized);
      patchSessionCache({ messages: normalized });
      setPendingQuestion(null);
      setPendingPlan(null);
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
      const ok = (evt as any).ok === true;
      const command = typeof (evt as any).command === "string" ? String((evt as any).command) : "";
      const result = (evt as any).result;
      if (!ok) {
        const error = typeof (evt as any).error === "string" ? (evt as any).error : "Command failed";
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
        const servers = Array.isArray(result?.config?.effectiveServers)
          ? (result.config.effectiveServers as Array<{ name: string; transport: string; scope: string; sourcePath?: string }>)
          : [];
        const action = typeof result?.action === "string" && result.action === "reload" ? "reload" as const : "status" as const;
        // serverTools: Record<string, string[]> — tools grouped by MCP server name
        const serverTools = result?.serverTools && typeof result.serverTools === "object" && !Array.isArray(result.serverTools)
          ? result.serverTools as Record<string, string[]>
          : {};

        const disabledServersForMcp = Array.isArray(result?.config?.disabledServers)
          ? result.config.disabledServers.filter((s: unknown): s is string => typeof s === "string")
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
        const servers = Array.isArray(result?.config?.effectiveServers)
          ? (result.config.effectiveServers as Array<{ name: string; transport: string; scope: string; sourcePath?: string }>)
          : [];
        const serverTools = result?.serverTools && typeof result.serverTools === "object" && !Array.isArray(result.serverTools)
          ? result.serverTools as Record<string, string[]>
          : {};
        const disabledServers = Array.isArray(result?.config?.disabledServers)
          ? result.config.disabledServers.filter((s: unknown): s is string => typeof s === "string")
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
        const enabled = !!(result as any)?.planModeEnabled;
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
        setMessages([]);
        setPendingQuestion(null);
        setPendingPlan(null);
        setActiveToolCalls(new Map());
        setMessageQueue([]);
        setSessionName(null);
        setAgentActive(false);
        patchSessionCache({
          messages: [],
          sessionName: null,
          agentActive: false,
        });
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

      if (authUrl) {
        const message: RelayMessage = {
          key: `mcp_auth:${ts}:${Math.random().toString(16).slice(2)}`,
          role: "system",
          timestamp: ts,
          content: `🔐 **${serverName}** requires authentication.\n\n[Click here to authenticate](${authUrl})`,
          isError: false,
        };
        setMessages((prev) => {
          const next = [...prev, message];
          patchSessionCache({ messages: next });
          return next;
        });
      }
      return;
    }

    if (type === "mcp_auth_complete") {
      // Silently ignore — auth success is noise on the happy path.
      // The CLI still logs to stderr for debugging.
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
      setMessages((prev) => {
        const next = [...prev, errMessage];
        patchSessionCache({ messages: next });
        return next;
      });
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
  }, [upsertMessage, upsertMessageDebounced, cancelPendingDeltas, appendLocalSystemMessage, scheduleToolStreamFlush]);

  React.useEffect(() => {
    const socket = io("/hub", { withCredentials: true });
    hubSocketRef.current = socket;

    const handleStateSnapshot = ({ sessionId, state }: { sessionId: string; state: SessionMetaState }) => {
      const currentSessionId = activeSessionRef.current;
      if (sessionId !== currentSessionId) return;
      const seen = metaVersionsRef.current.get(sessionId) ?? 0;
      if (state.version < seen) return;
      metaVersionsRef.current.set(sessionId, state.version);
      applyMetaStateSnapshot(state);
    };

    const handleMetaEvent = (payload: { sessionId: string; version: number } & Record<string, unknown>) => {
      const currentSessionId = activeSessionRef.current;
      if (payload.sessionId !== currentSessionId) return;
      const { sessionId, version, ...event } = payload;
      const seen = metaVersionsRef.current.get(sessionId) ?? 0;
      if (version <= seen) return;
      metaVersionsRef.current.set(sessionId, version);
      applyMetaPatch(metaEventToStatePatch(event as any));
      if ((event as any).type === "mcp_startup_report" && (event as any).report) {
        // Buffer if session not yet hydrated — the new slim CLI no longer retries
        // in heartbeats, so without this the report would be lost for live events
        // that race session_active delivery.
        if (sessionHydratedRef.current) {
          applyMcpReport((event as any).report);
        } else {
          pendingMcpReportRef.current = (event as any).report as Record<string, unknown>;
        }
      }
    };

    // Re-subscribe to the current session's meta room after non-recovered reconnects
    // (e.g., server restart). Without this, the client stops receiving meta_event
    // updates until the user switches sessions or reloads.
    // Also clear the stored meta version so that the first state_snapshot/meta_event
    // arriving after reconnect (version ≥ 1) is not dropped as "stale" — the server
    // resets its version counter to 0 on restart, so any previously-seen version
    // would cause all new events to be silently ignored.
    const handleReconnect = () => {
      const currentSessionId = activeSessionRef.current;
      if (currentSessionId) {
        metaVersionsRef.current.delete(currentSessionId);
        socket.emit("subscribe_session_meta", { sessionId: currentSessionId });
      }
    };

    socket.on("state_snapshot", handleStateSnapshot);
    socket.on("meta_event", handleMetaEvent);
    socket.on("connect", handleReconnect);

    const initialSessionId = activeSessionRef.current;
    if (initialSessionId) {
      socket.emit("subscribe_session_meta", { sessionId: initialSessionId });
      prevMetaSessionRef.current = initialSessionId;
    }

    return () => {
      socket.off("state_snapshot", handleStateSnapshot);
      socket.off("meta_event", handleMetaEvent);
      socket.off("connect", handleReconnect);
      socket.disconnect();
      hubSocketRef.current = null;
    };
  }, [applyMetaStateSnapshot, applyMetaPatch, applyMcpReport]);

  React.useEffect(() => {
    const hubSock = hubSocketRef.current;
    if (!hubSock) return;

    const prevId = prevMetaSessionRef.current;
    const nextId = activeSessionId;

    if (prevId && prevId !== nextId) {
      hubSock.emit("unsubscribe_session_meta", { sessionId: prevId });
      metaVersionsRef.current.delete(prevId);
    }

    if (nextId) {
      hubSock.emit("subscribe_session_meta", { sessionId: nextId });
      prevMetaSessionRef.current = nextId;
    } else {
      prevMetaSessionRef.current = null;
    }
  }, [activeSessionId]);

  const openSession = React.useCallback((relaySessionId: string) => {
    // Flush/cancel any pending RAF queues (streaming deltas & tool-stream
    // partials) from the previous session so they can't leak into the new one.
    cancelPendingDeltas();

    // Stop any in-flight haptics from the previous session immediately.
    cancelHaptic();

    viewerWsRef.current?.disconnect();
    viewerWsRef.current = null;

    // Clear any existing stale-connection timer from a previous session.
    if (staleCheckTimerRef.current !== null) {
      clearInterval(staleCheckTimerRef.current);
      staleCheckTimerRef.current = null;
    }

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
    setActiveSessionId(relaySessionId);
    setViewerStatus("Connecting…");
    setRetryState(null);
    setActiveToolCalls(new Map());
    setIsChangingModel(false);
    setUsageRefreshing(false);
    setResumeSessions([]);
    setResumeSessionsLoading(false);

    const cached = sessionUiCacheRef.current.get(relaySessionId);
    setMessages(cached?.messages ?? []);
    setActiveModel(cached?.activeModel ?? null);
    setSessionName(cached?.sessionName ?? null);
    setAvailableModels(cached?.availableModels ?? []);
    setAvailableCommands(cached?.availableCommands ?? []);
    setAgentActive(cached?.agentActive ?? false);
    setIsCompacting(cached?.isCompacting ?? false);
    setEffortLevel(cached?.effortLevel ?? null);
    setPlanModeEnabled(cached?.planModeEnabled ?? false);
    setAuthSource(cached?.authSource ?? null);
    setTokenUsage(cached?.tokenUsage ?? null);
    setProviderUsage(cached?.providerUsage ?? null);
    setLastHeartbeatAt(cached?.lastHeartbeatAt ?? null);
    setTodoList(cached?.todoList ?? []);
    // Don't restore pendingQuestion/pendingPlan from cache — the cache can be
    // stale if the user answered/rejected before the next heartbeat arrived.
    // The heartbeat (which arrives within seconds) will restore them with
    // authoritative values from the runner.
    setPendingQuestion(null);
    setPendingPlan(null);

    const socket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> = io("/viewer", {
      auth: { sessionId: relaySessionId },
      withCredentials: true,
    });
    viewerWsRef.current = socket;

    // Stale-connection watchdog: if the socket thinks it's connected but
    // no event has arrived for STALE_THRESHOLD_MS, force a reconnect.
    // This catches NAT timeouts, middlebox drops, and backgrounded-tab
    // scenarios where socket.io's own ping/pong doesn't fire in time.
    staleCheckTimerRef.current = setInterval(() => {
      if (activeSessionRef.current !== relaySessionId) return;
      if (!socket.connected) return;
      const elapsed = Date.now() - lastViewerEventAtRef.current;
      if (elapsed > STALE_THRESHOLD_MS) {
        console.warn(`[relay] Stale connection detected (${Math.round(elapsed / 1000)}s since last event). Reconnecting…`);
        socket.disconnect();
        socket.connect();
      }
    }, STALE_CHECK_INTERVAL_MS);

    socket.on("connected", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      lastViewerEventAtRef.current = Date.now();

      const replayOnly = data.replayOnly === true;
      setViewerStatus(replayOnly ? "Snapshot replay" : "Connected");

      // Seed the last known sequence number so gap detection works from the start.
      if (typeof data.lastSeq === "number") {
        lastSeqRef.current = data.lastSeq;
      }

      // Reflect initial active status from connected message.
      if (typeof data.isActive === "boolean") {
        setAgentActive(data.isActive);
        patchSessionCache({ agentActive: data.isActive });
      }

      if (Object.prototype.hasOwnProperty.call(data, "sessionName")) {
        const nextName = normalizeSessionName(data.sessionName);
        setSessionName(nextName);
        patchSessionCache({ sessionName: nextName });
      }

      // Tell the runner we connected so it can push capabilities (models/commands/etc.)
      socket.emit("connected", {});
    });

    socket.on("event", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      lastViewerEventAtRef.current = Date.now();

      // Detect sequence gaps; request a resync if we missed events.
      // This is safe during chunked delivery because the server's resync
      // handler now falls back to getPendingChunkedSnapshot() when lastState
      // hasn't been assembled yet, and the resync response is a non-chunked
      // session_active that sets lastCompletedSnapshotRef, rejecting any
      // subsequently arriving stale chunks.
      const seq = typeof data.seq === "number" ? data.seq : null;
      if (seq !== null && lastSeqRef.current !== null) {
        const expected = lastSeqRef.current + 1;
        if (seq > expected) {
          // Gap detected — request a resync snapshot from the server.
          console.warn(`[relay] Sequence gap: expected ${expected}, got ${seq}. Requesting resync.`);
          socket.emit("resync", {});
        }
      }
      if (seq !== null) lastSeqRef.current = seq;

      handleRelayEvent(data.event, seq ?? undefined);
    });

    socket.on("exec_result", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      lastViewerEventAtRef.current = Date.now();
      handleRelayEvent({ type: "exec_result", ...data });
    });

    socket.on("disconnected", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      // Server is actively talking to us — reset stale clock.
      lastViewerEventAtRef.current = Date.now();
      // "Session reconnected" means a new worker registered with the same session ID
      // (e.g. the user ran /restart in the CLI terminal rather than via the web UI
      // command bar).  Treat it identically to a UI-initiated restart so the
      // existing auto-reconnect logic fires when the session comes back live.
      if (data.reason === "Session reconnected" && restartPendingSessionIdRef.current !== relaySessionId) {
        restartPendingSessionIdRef.current = relaySessionId;
        if (restartPendingTimerRef.current) clearTimeout(restartPendingTimerRef.current);
        restartPendingTimerRef.current = setTimeout(() => {
          restartPendingSessionIdRef.current = null;
          restartPendingTimerRef.current = null;
        }, 60_000);
      }
      const isRestarting = restartPendingSessionIdRef.current === relaySessionId;
      if (!isRestarting) {
        setViewerStatus(data.reason || "Disconnected");
      } else {
        setViewerStatus("Restarting CLI\u2026");
      }
      setPendingQuestion(null);
      setPendingPlan(null);
      setIsChangingModel(false);
    });

    socket.on("error", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      // Server is actively talking to us — reset stale clock.
      lastViewerEventAtRef.current = Date.now();
      setViewerStatus(data.message || "Failed to load session");
    });

    socket.on("connect_error", () => {
      if (activeSessionRef.current === relaySessionId) {
        setViewerStatus("Connection error");
      }
    });

    socket.on("disconnect", (reason) => {
      if (activeSessionRef.current === relaySessionId) {
        const isRestarting = restartPendingSessionIdRef.current === relaySessionId;
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
        // Reset the stale clock so we don't fire immediately on reconnect.
        lastViewerEventAtRef.current = Date.now();

        // When the server explicitly disconnects us (reason "io server disconnect"),
        // socket.io permanently disables auto-reconnect on the client. This happens
        // when the session isn't live yet — e.g. the server just restarted and the
        // CLI hasn't re-registered. Schedule a manual reconnect so we pick up the
        // session once it's available again.
        // The activeSessionRef guard ensures this is a no-op if the user
        // switches to a different session before the timer fires.
        if (reason === "io server disconnect") {
          setTimeout(() => {
            if (activeSessionRef.current === relaySessionId && !socket.connected) {
              socket.connect();
            }
          }, 2000);
        }
      }
    });
  }, [handleRelayEvent, patchSessionCache, cancelPendingDeltas]);

  // Auto-reopen the last viewed session once live sessions arrive.
  React.useEffect(() => {
    if (restoredRef.current) return;
    if (liveSessions.length === 0) return;
    const lastId = localStorage.getItem("pp.lastSessionId");
    if (!lastId) return;
    const still_live = liveSessions.some((s) => s.sessionId === lastId);
    if (!still_live) return;
    restoredRef.current = true;
    openSession(lastId);
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

  const sendSessionInput = React.useCallback(async (message: { text: string; files?: Array<{ mediaType?: string; filename?: string; url?: string }>; deliverAs?: "steer" | "followUp" } | string) => {
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
          const blob = await fetch(file.url).then((res) => res.blob());
          const uploadFile = new File([blob], displayName, {
            type: file.mediaType || blob.type || "application/octet-stream",
          });
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
          setMessages((prev) => [
            ...prev,
            {
              key: `user:steer:${now}:${Math.random().toString(16).slice(2)}`,
              role: "user",
              timestamp: now,
              content: trimmed,
            },
          ]);
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
  }, []);

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
    }
    try {
      const { type: _type, ...rest } = payload;
      socket.emit("exec", rest as any);
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
      auth: { sessionId },
      withCredentials: true,
    });

    const cleanup = () => tempSocket.disconnect();
    const timeout = setTimeout(cleanup, 10_000);

    tempSocket.on("connected", () => {
      clearTimeout(timeout);
      const execId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      // Listen for exec_result confirmation before disconnecting
      const resultTimeout = setTimeout(cleanup, 5_000); // fallback if no reply
      tempSocket.on("exec_result" as any, (data: any) => {
        if (data && data.id === execId) {
          clearTimeout(resultTimeout);
          cleanup();
        }
      });

      tempSocket.emit("exec", {
        id: execId,
        command: "end_session",
      } as any);
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
        !e.shiftKey &&
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
    setSpawnCwd("");
    setRecentFolders([]);
    setNewSessionOpen(true);
  }, []);

  const handleDuplicateSession = React.useCallback((runnerId: string, cwd: string) => {
    setSpawnRunnerId(runnerId);
    setSpawnPreselectedRunnerId(runnerId);
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
    };

    let sessionId: string | null = null;
    try {
      const res = await fetch("/api/runners/spawn", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => null) as any;
      if (!res.ok) {
        const msg = body && typeof body.error === "string" ? body.error : `Spawn failed (HTTP ${res.status})`;
        setViewerStatus(msg);
        return;
      }

      sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      if (!sessionId) {
        setViewerStatus("Spawn failed: missing sessionId");
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
      const detail = err instanceof Error ? err.message : String(err);
      setViewerStatus(`Spawn failed: ${detail}`);
    } finally {
      setSpawningSession(false);
    }
  }, [spawningSession, spawnRunnerId, spawnCwd, handleOpenSession, waitForSessionToGoLive]);

  /** Spawn handler for the new wizard dialog. */
  const handleWizardSpawn = React.useCallback(async (runnerId: string, cwd: string | undefined) => {
    setViewerStatus("Spawning session…");

    const payload: any = { runnerId, ...(cwd ? { cwd } : {}) };
    const res = await fetch("/api/runners/spawn", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => null) as any;
    if (!res.ok) {
      const msg = body && typeof body.error === "string" ? body.error : `Spawn failed (HTTP ${res.status})`;
      throw new Error(msg);
    }

    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
    if (!sessionId) throw new Error("Spawn failed: missing sessionId");

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
      socket.on("trigger_error" as any, onTriggerError);
      const errorCleanup = () => { socket.off("trigger_error" as any, onTriggerError); };

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

      const body = await res.json().catch(() => null) as any;
      if (!res.ok) {
        const msg = body && typeof body.error === "string" ? body.error : `Spawn failed (HTTP ${res.status})`;
        setViewerStatus(msg);
        return;
      }

      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      if (!sessionId) {
        setViewerStatus("Spawn failed: missing sessionId");
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
      const detail = err instanceof Error ? err.message : String(err);
      setViewerStatus(`Agent spawn failed: ${detail}`);
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

  // When both panels are at the same position, combine them into a single tabbed panel
  const areCombined = showTerminal && showFileExplorer && terminalPosition === filesPosition
    && !!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd;

  if (isPending) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center bg-background gap-2 animate-in fade-in duration-300">
        <Spinner className="size-8 text-primary/60" />
      </div>
    );
  }

  if (!session) {
    return <AuthPage onAuthenticated={() => authClient.$store.notify("$sessionSignal")} />
  }

  const rawUser = session && typeof session === "object" ? (session as any).user : undefined;
  const userName = rawUser && typeof rawUser.name === "string" ? (rawUser.name as string) : "";
  const userEmail = rawUser && typeof rawUser.email === "string" ? (rawUser.email as string) : "";
  const userLabel = userName || userEmail || "Account";

  function relayStatusLabel(status: DotState, short = false) {
    if (status === "connected") return short ? "Connected" : "Relay connected";
    if (status === "connecting") return "Connecting…";
    return short ? "Disconnected" : "Relay disconnected";
  }

  function relayStatusDot(status: DotState) {
    return `inline-block h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500 shadow-[0_0_4px_#22c55e80]" : status === "connecting" ? "bg-slate-400" : "bg-red-500"}`;
  }

  function initials(value: string) {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase()).join("") || "U";
  }

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
    <TooltipProvider delayDuration={0}>
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background pp-safe-left pp-safe-right">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground"
      >
        Skip to content
      </a>
      {/* ── Desktop header ────────────────────────────────────────────── */}
      <header className="hidden md:flex items-center justify-between gap-3 border-b bg-background px-4 pb-2 pt-[calc(0.5rem_+_env(safe-area-inset-top))] flex-shrink-0">
        <div className="flex items-center gap-3 flex-shrink-0">
          <PizzaLogo />
          <span className="text-sm font-semibold">PizzaPi</span>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={relayStatusDot(relayStatus)} />
            <span>{relayStatusLabel(relayStatus)}</span>
          </div>
          {(providerUsage || authSource) && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <UsageIndicator
                usage={providerUsage}
                authSource={authSource}
                activeProvider={activeModel?.provider}
                onRefresh={refreshUsage}
                refreshing={usageRefreshing}
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => setIsDark((d) => !d)}
                aria-label="Toggle dark mode"
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle dark mode</TooltipContent>
          </Tooltip>

          <NotificationToggle />
          <HapticsToggle />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => { setShowApiKeys(true); setShowRunners(false); }}
                aria-label="Manage API keys"
              >
                <KeyRound className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Manage API keys</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => setShowShortcutsHelp(true)}
                aria-label="Keyboard shortcuts"
              >
                <Keyboard className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold flex-shrink-0">
                  {initials(userLabel)}
                </span>
                <span className="truncate text-left max-w-40">{userLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{userName || "Signed in"}</span>
              </DropdownMenuLabel>
              {userEmail && (
                <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{userEmail}</div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { setShowApiKeys(true); setShowRunners(false); }}>
                <KeyRound className="h-4 w-4" />
                API keys
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setShowRunners(true); setShowApiKeys(false); setActiveSessionId(null); }}>
                <HardDrive className="h-4 w-4" />
                Runners
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHiddenModelsOpen(true)}>
                <EyeOff className="h-4 w-4" />
                Model visibility
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setChangePasswordOpen(true)}>
                <Lock className="h-4 w-4" />
                Change password
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* ── Mobile header ─────────────────────────────────────────────── */}
      {/* Fixed so the keyboard sliding up never pushes the header off-screen */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 border-b bg-background px-3 pp-safe-left pp-safe-right"
        style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))", paddingBottom: "0.5rem" }}
      >
        {/* Left: sidebar toggle — no Tooltip wrapper; on mobile, tooltips
            intercept the first tap and prevent the click from firing. */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          onClick={() => setSidebarOpen(prev => !prev)}
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          <PanelLeftOpen className={`h-5 w-5 transition-transform duration-300 ${sidebarOpen ? "rotate-180" : ""}`} />
        </Button>

        {/* Center: session switcher pill or logo */}
        <div className="flex-1 min-w-0 flex justify-center">
          <DropdownMenu open={sessionSwitcherOpen} onOpenChange={setSessionSwitcherOpen}>
            <DropdownMenuTrigger asChild>
              {activeSessionId ? (
                <button
                  className="inline-flex items-center gap-2 min-w-0 max-w-full rounded-xl bg-muted/50 border border-border/60 px-3 py-1.5 hover:bg-muted transition-colors"
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 transition-colors ${agentActive ? "bg-green-400 shadow-[0_0_5px_#4ade8080] animate-pulse" : "bg-slate-400"}`}
                  />
                  {activeModel?.provider && (
                    <ProviderIcon provider={activeModel.provider} className="size-3.5 flex-shrink-0" />
                  )}
                  <span className="truncate text-sm font-medium">
                    {sessionName || `Session ${activeSessionId.slice(0, 8)}…`}
                  </span>
                  <ChevronsUpDown className="h-3 w-3 opacity-40 flex-shrink-0" />
                </button>
              ) : (
                <button className="inline-flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-muted/50 transition-colors">
                  <PizzaLogo className="!w-7 !h-7" />
                  <span className="text-sm font-semibold">PizzaPi</span>
                  <span className={relayStatusDot(relayStatus)} />
                </button>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-72 max-h-[70vh] overflow-y-auto">
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Sessions</span>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${relayStatus === "connected" ? "bg-green-500 shadow-[0_0_4px_#22c55e80]" : relayStatus === "connecting" ? "bg-slate-400" : "bg-red-500"}`} />
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {liveSessions.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground text-center italic">No live sessions</div>
              ) : (
                liveSessions
                  .slice()
                  .sort((a, b) => {
                    const aT = Date.parse(a.lastHeartbeatAt ?? a.startedAt);
                    const bT = Date.parse(b.lastHeartbeatAt ?? b.startedAt);
                    return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
                  })
                  .map((s) => {
                    const isActive = s.sessionId === activeSessionId;
                    const provider = s.model?.provider ?? (isActive ? activeModel?.provider : undefined) ?? "unknown";
                    const label = s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`;
                    return (
                      <DropdownMenuItem
                        key={s.sessionId}
                        onSelect={() => {
                          handleOpenSession(s.sessionId);
                          setSessionSwitcherOpen(false);
                        }}
                        className="flex items-center gap-2.5 py-2.5"
                      >
                        {/* Provider icon + activity badge */}
                        <div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-muted">
                          <ProviderIcon provider={provider} className="size-4 text-muted-foreground" />
                          <span
                            className={`absolute -top-0.5 -right-0.5 inline-block h-2 w-2 rounded-full border-2 border-popover ${s.isActive ? "bg-blue-400 animate-pulse" : "bg-green-600"}`}
                            title={s.isActive ? "Generating" : "Idle"}
                          />
                        </div>
                        {/* Name + path */}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{label}</div>
                          {s.cwd && (
                            <div className="text-[0.65rem] text-muted-foreground truncate">{s.cwd.split("/").slice(-2).join("/")}</div>
                          )}
                        </div>
                        {/* Checkmark for active */}
                        {isActive && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
                      </DropdownMenuItem>
                    );
                  })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { handleNewSession(); setSessionSwitcherOpen(false); }} className="gap-2">
                <Plus className="h-4 w-4" />
                New session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Right: usage + account */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {(providerUsage || authSource) && (
            <div className="hidden xs:flex">
              <UsageIndicator
                usage={providerUsage}
                authSource={authSource}
                activeProvider={activeModel?.provider}
                onRefresh={refreshUsage}
                refreshing={usageRefreshing}
              />
            </div>
          )}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="User menu">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
                      {initials(userLabel)}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>User menu</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{userName || "Signed in"}</span>
              </DropdownMenuLabel>
              {userEmail && (
                <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{userEmail}</div>
              )}
              {(providerUsage || authSource) && (
                <div className="px-2 py-1.5 border-t border-border/50">
                  <UsageIndicator
                    usage={providerUsage}
                    authSource={authSource}
                    activeProvider={activeModel?.provider}
                    onRefresh={refreshUsage}
                    refreshing={usageRefreshing}
                  />
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setIsDark((d) => !d)}>
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {isDark ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <MobileNotificationMenuItem />
              <MobileHapticsMenuItem />
              <DropdownMenuItem onSelect={() => { setShowApiKeys(true); setShowRunners(false); setSidebarOpen(false); }}>
                <KeyRound className="h-4 w-4" />
                API keys
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setShowRunners(true); setShowApiKeys(false); setActiveSessionId(null); setSidebarOpen(false); }}>
                <HardDrive className="h-4 w-4" />
                Runners
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setHiddenModelsOpen(true); setSidebarOpen(false); }}>
                <EyeOff className="h-4 w-4" />
                Model visibility
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setChangePasswordOpen(true); setSidebarOpen(false); }}>
                <Lock className="h-4 w-4" />
                Change password
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
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
          <SessionSidebar
            onOpenSession={handleOpenSession}
            onNewSession={handleNewSession}
            onClearSelection={handleClearSelection}
            onShowRunners={() => { setShowRunners(true); setShowApiKeys(false); setActiveSessionId(null); }}
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
          />
        </div>

        {/* Mobile overlay — fades in/out with the sidebar.
            Swipe left anywhere on the backdrop to close; tap to close instantly. */}
        <div
          className={cn(
            "pp-sidebar-overlay absolute inset-0 z-30 bg-black/50 md:hidden transition-opacity duration-300",
            sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          )}
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
          ref={filesContainerRef}
          className={cn(
            "relative flex flex-1 min-w-0 h-full overflow-hidden",
            showFileExplorer && filesPosition === "bottom" ? "flex-col" : "flex-row",
          )}
          onPointerMove={showFileExplorer ? handleFilesOuterPointerMove : undefined}
          onPointerUp={showFileExplorer ? handleFilesOuterPointerUp : undefined}
          onPointerCancel={showFileExplorer ? handleFilesOuterPointerUp : undefined}
        >
          {/* Drop-zone overlay while dragging the file explorer header */}
          {filesDragActive && (
            <div className="absolute inset-0 z-50 pointer-events-none hidden md:block">
              <div className={cn(
                "absolute top-0 left-0 w-[35%] h-[55%] flex flex-col items-center justify-center gap-2 border-r-2 transition-colors duration-100",
                filesDragZone === "left" ? "bg-blue-500/20 border-blue-500" : "bg-zinc-900/60 border-zinc-700/60",
              )}>
                <svg className={cn("size-6 transition-colors", filesDragZone === "left" ? "text-blue-400" : "text-zinc-500")} viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="14" rx="1.5"/><rect x="9" y="1" width="6" height="14" rx="1.5" opacity=".3"/></svg>
                <span className={cn("text-xs font-medium transition-colors", filesDragZone === "left" ? "text-blue-300" : "text-zinc-500")}>Left</span>
              </div>
              <div className={cn(
                "absolute top-0 right-0 w-[35%] h-[55%] flex flex-col items-center justify-center gap-2 border-l-2 transition-colors duration-100",
                filesDragZone === "right" ? "bg-blue-500/20 border-blue-500" : "bg-zinc-900/60 border-zinc-700/60",
              )}>
                <svg className={cn("size-6 transition-colors", filesDragZone === "right" ? "text-blue-400" : "text-zinc-500")} viewBox="0 0 16 16" fill="currentColor"><rect x="9" y="1" width="6" height="14" rx="1.5"/><rect x="1" y="1" width="6" height="14" rx="1.5" opacity=".3"/></svg>
                <span className={cn("text-xs font-medium transition-colors", filesDragZone === "right" ? "text-blue-300" : "text-zinc-500")}>Right</span>
              </div>
              <div className={cn(
                "absolute bottom-0 left-0 right-0 h-[40%] flex flex-col items-center justify-center gap-2 border-t-2 transition-colors duration-100",
                filesDragZone === "bottom" ? "bg-blue-500/20 border-blue-500" : "bg-zinc-900/60 border-zinc-700/60",
              )}>
                <svg className={cn("size-6 transition-colors", filesDragZone === "bottom" ? "text-blue-400" : "text-zinc-500")} viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="9" width="14" height="6" rx="1.5"/><rect x="1" y="1" width="14" height="6" rx="1.5" opacity=".3"/></svg>
                <span className={cn("text-xs font-medium transition-colors", filesDragZone === "bottom" ? "text-blue-300" : "text-zinc-500")}>Bottom</span>
              </div>
            </div>
          )}

          {/* ── File Explorer panels ── */}
          {/* Mobile overlay — always rendered when file explorer is open */}
          {showFileExplorer && activeSessionInfo?.runnerId && activeSessionInfo?.cwd && (
            <div
              className="md:hidden fixed inset-0 z-[60] flex flex-col bg-zinc-950 pp-safe-left pp-safe-right"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
              <FileExplorer
                runnerId={activeSessionInfo.runnerId}
                cwd={activeSessionInfo.cwd}
                className="h-full"
                onClose={() => setShowFileExplorer(false)}
                position={filesPosition}
                onPositionChange={handleFilesPositionChange}
                onDragStart={handleFilesDragStart}
              />
            </div>
          )}

          {/* Desktop file explorer — only when NOT combined with terminal */}
          {showFileExplorer && !areCombined && activeSessionInfo?.runnerId && activeSessionInfo?.cwd && (
            <>
              {/* Desktop: left panel */}
              {filesPosition === "left" && (
                <>
                  <div className="hidden md:flex flex-col shrink-0" style={{ width: filesWidth }}>
                    <FileExplorer
                      runnerId={activeSessionInfo.runnerId}
                      cwd={activeSessionInfo.cwd}
                      className="h-full"
                      onClose={() => setShowFileExplorer(false)}
                      position={filesPosition}
                      onPositionChange={handleFilesPositionChange}
                      onDragStart={handleFilesDragStart}
                    />
                  </div>
                  <div
                    className="hidden md:flex w-[5px] cursor-col-resize shrink-0 items-center justify-center group"
                    onPointerDown={handleFilesWidthLeftResizeStart}
                  >
                    <div className="h-full w-px bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors" />
                  </div>
                </>
              )}

              {/* Desktop: right panel — order-last so it appears after the terminal column */}
              {filesPosition === "right" && (
                <>
                  <div
                    className="hidden md:flex w-[5px] cursor-col-resize shrink-0 items-center justify-center group order-last"
                    onPointerDown={handleFilesWidthRightResizeStart}
                  >
                    <div className="h-full w-px bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors" />
                  </div>
                  <div className="hidden md:flex flex-col shrink-0 order-last" style={{ width: filesWidth }}>
                    <FileExplorer
                      runnerId={activeSessionInfo.runnerId}
                      cwd={activeSessionInfo.cwd}
                      className="h-full"
                      onClose={() => setShowFileExplorer(false)}
                      position={filesPosition}
                      onPositionChange={handleFilesPositionChange}
                      onDragStart={handleFilesDragStart}
                    />
                  </div>
                </>
              )}

              {/* Desktop: bottom panel — order-last so it appears below the terminal column */}
              {filesPosition === "bottom" && (
                <>
                  <div
                    className="hidden md:flex h-[5px] cursor-row-resize shrink-0 items-center justify-center group order-last"
                    onPointerDown={handleFilesHeightResizeStart}
                  >
                    <div className="w-full h-px bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors" />
                  </div>
                  <div className="hidden md:flex flex-col shrink-0 order-last" style={{ height: filesHeight }}>
                    <FileExplorer
                      runnerId={activeSessionInfo.runnerId}
                      cwd={activeSessionInfo.cwd}
                      className="h-full"
                      onClose={() => setShowFileExplorer(false)}
                      position={filesPosition}
                      onPositionChange={handleFilesPositionChange}
                      onDragStart={handleFilesDragStart}
                    />
                  </div>
                </>
              )}
            </>
          )}

          <div
            ref={terminalColumnRef}
            className={cn(
              "relative flex flex-1 min-w-0",
              showFileExplorer && filesPosition === "bottom" ? "min-h-0" : "h-full",
              showTerminal && terminalPosition !== "bottom" ? "flex-row" : "flex-col",
            )}
            onPointerMove={showTerminal ? handleOuterPointerMove : undefined}
            onPointerUp={showTerminal ? handleOuterPointerUp : undefined}
            onPointerCancel={showTerminal ? handleOuterPointerUp : undefined}
          >
            <div
              id="main-content"
              tabIndex={-1}
              className={cn(
              "flex flex-col flex-1 min-h-0",
              showTerminal && "overflow-hidden",
              showTerminal && terminalPosition !== "bottom" && "min-w-0",
              showTerminal && terminalPosition === "left" && "order-last",
            )}>
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
                  onToggleFileExplorer={() => setShowFileExplorer((v) => !v)}
                  showFileExplorerButton={!!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd}
                  todoList={todoList}
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
                />
              )}
            </div>
            {/* Mobile: terminal overlay (always separate from combined) */}
            {showTerminal && (
              <div
                className="md:hidden fixed inset-0 z-[60] flex flex-col bg-zinc-950 pp-safe-left pp-safe-right"
                style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
              >
                <TerminalManager
                  className="h-full"
                  onClose={() => setShowTerminal(false)}
                  position={terminalPosition}
                  onPositionChange={handleTerminalPositionChange}
                  onDragStart={handlePanelDragStart}
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
              </div>
            )}

            {/* Desktop: Combined panel (terminal + file explorer at same position) */}
            {areCombined && (
              <>
                <div
                  className={cn(
                    "hidden md:flex shrink-0 items-center justify-center group",
                    terminalPosition === "bottom"
                      ? "h-[5px] cursor-row-resize"
                      : "w-[5px] cursor-col-resize",
                  )}
                  style={{ order: terminalPosition === "left" ? 1 : 9998 }}
                  onPointerDown={handleTerminalResizeStart}
                >
                  <div className={cn(
                    "bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors",
                    terminalPosition === "bottom" ? "w-full h-px" : "h-full w-px",
                  )} />
                </div>
                <div
                  className="hidden md:flex flex-col shrink-0"
                  style={{
                    order: terminalPosition === "left" ? 0 : 9999,
                    ...(terminalPosition === "bottom"
                      ? { height: terminalHeight }
                      : { width: terminalWidth }),
                  }}
                >
                  <CombinedPanel
                    activeTabId={combinedActiveTab}
                    onActiveTabChange={handleCombinedTabChange}
                    position={terminalPosition}
                    onPositionChange={handleCombinedPositionChange}
                    onDragStart={handlePanelDragStart}
                    className="h-full"
                    tabs={[
                      {
                        id: "terminal",
                        label: "Terminal",
                        icon: <TerminalIcon className="size-3.5" />,
                        onClose: () => { setShowTerminal(false); handleCombinedTabChange("files"); },
                        // Dragging the Terminal tab detaches it (moves only the terminal panel)
                        onDragStart: handleTerminalTabDragStart,
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
                      },
                      {
                        id: "files",
                        label: "Files",
                        icon: <FolderTree className="size-3.5" />,
                        onClose: () => { setShowFileExplorer(false); handleCombinedTabChange("terminal"); },
                        // Dragging the Files tab detaches it (moves only the files panel)
                        onDragStart: handleFilesDragStart,
                        content: (
                          <FileExplorer
                            runnerId={activeSessionInfo!.runnerId!}
                            cwd={activeSessionInfo!.cwd}
                            className="h-full"
                          />
                        ),
                      },
                    ]}
                  />
                </div>
              </>
            )}

            {/* Desktop: standalone terminal (when not combined) */}
            {showTerminal && !areCombined && (
              <>
                {/*
                  Single always-mounted instance so xterm state survives position changes.
                  CSS `order` repositions the handle and panel without unmounting:
                    left   → panel(0)  handle(1)  session(9999 via order-last)
                    right  → session(0) handle(9998) panel(9999)
                    bottom → session(0) handle(9998) panel(9999)  [outer is flex-col]
                */}
                <div
                  className={cn(
                    "hidden md:flex shrink-0 items-center justify-center group",
                    terminalPosition === "bottom"
                      ? "h-[5px] cursor-row-resize"
                      : "w-[5px] cursor-col-resize",
                  )}
                  style={{ order: terminalPosition === "left" ? 1 : 9998 }}
                  onPointerDown={handleTerminalResizeStart}
                >
                  <div className={cn(
                    "bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors",
                    terminalPosition === "bottom" ? "w-full h-px" : "h-full w-px",
                  )} />
                </div>
                <div
                  className="hidden md:flex flex-col shrink-0"
                  style={{
                    order: terminalPosition === "left" ? 0 : 9999,
                    ...(terminalPosition === "bottom"
                      ? { height: terminalHeight }
                      : { width: terminalWidth }),
                  }}
                >
                  <TerminalManager
                    className="h-full"
                    onClose={() => setShowTerminal(false)}
                    position={terminalPosition}
                    onPositionChange={handleTerminalPositionChange}
                    onDragStart={handlePanelDragStart}
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
                </div>
              </>
            )}

            {/* Drop-zone overlay shown while dragging the panel header */}
            {panelDragActive && (
              <div className="absolute inset-0 z-50 pointer-events-none hidden md:block">
                {/* Bottom zone */}
                <div className={cn(
                  "absolute bottom-0 left-0 right-0 h-[40%] flex flex-col items-center justify-center gap-2 border-t-2 transition-colors duration-100",
                  panelDragZone === "bottom" ? "bg-blue-500/20 border-blue-500" : "bg-zinc-900/60 border-zinc-700/60",
                )}>
                  <svg className={cn("size-6 transition-colors", panelDragZone === "bottom" ? "text-blue-400" : "text-zinc-500")} viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="9" width="14" height="6" rx="1.5"/><rect x="1" y="1" width="14" height="6" rx="1.5" opacity=".3"/></svg>
                  <span className={cn("text-xs font-medium transition-colors", panelDragZone === "bottom" ? "text-blue-300" : "text-zinc-500")}>Bottom</span>
                </div>
                {/* Right zone */}
                <div className={cn(
                  "absolute top-0 right-0 w-[35%] h-[55%] flex flex-col items-center justify-center gap-2 border-l-2 transition-colors duration-100",
                  panelDragZone === "right" ? "bg-blue-500/20 border-blue-500" : "bg-zinc-900/60 border-zinc-700/60",
                )}>
                  <svg className={cn("size-6 transition-colors", panelDragZone === "right" ? "text-blue-400" : "text-zinc-500")} viewBox="0 0 16 16" fill="currentColor"><rect x="9" y="1" width="6" height="14" rx="1.5"/><rect x="1" y="1" width="6" height="14" rx="1.5" opacity=".3"/></svg>
                  <span className={cn("text-xs font-medium transition-colors", panelDragZone === "right" ? "text-blue-300" : "text-zinc-500")}>Right</span>
                </div>
                {/* Left zone */}
                <div className={cn(
                  "absolute top-0 left-0 w-[35%] h-[55%] flex flex-col items-center justify-center gap-2 border-r-2 transition-colors duration-100",
                  panelDragZone === "left" ? "bg-blue-500/20 border-blue-500" : "bg-zinc-900/60 border-zinc-700/60",
                )}>
                  <svg className={cn("size-6 transition-colors", panelDragZone === "left" ? "text-blue-400" : "text-zinc-500")} viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="14" rx="1.5"/><rect x="9" y="1" width="6" height="14" rx="1.5" opacity=".3"/></svg>
                  <span className={cn("text-xs font-medium transition-colors", panelDragZone === "left" ? "text-blue-300" : "text-zinc-500")}>Left</span>
                </div>
              </div>
            )}
          </div>
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
  );
}
