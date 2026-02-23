import * as React from "react";
import { SessionSidebar, type DotState, type HubSession } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import { ProviderIcon } from "@/components/ProviderIcon";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { RunnerTokenManager } from "@/components/RunnerTokenManager";
import { RunnerManager } from "@/components/RunnerManager";
import { PizzaLogo } from "@/components/PizzaLogo";
import { authClient, useSession, signOut } from "@/lib/auth-client";
import { io, type Socket } from "socket.io-client";
import type { ViewerServerToClientEvents, ViewerClientToServerEvents } from "@pizzapi/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { Sun, Moon, LogOut, KeyRound, X, User, ChevronsUpDown, PanelLeftOpen, HardDrive, Bell, BellOff, Check, Plus } from "lucide-react";
import { NotificationToggle, MobileNotificationMenuItem } from "@/components/NotificationToggle";
import { UsageIndicator, type ProviderUsageMap } from "@/components/UsageIndicator";
import { TerminalManager } from "@/components/TerminalManager";
import { FileExplorer } from "@/components/FileExplorer";
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

function toRelayMessage(raw: unknown, fallbackId: string): RelayMessage | null {
  if (!raw || typeof raw !== "object") return null;

  const msg = raw as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : "message";
  const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
  const id = typeof msg.id === "string" ? msg.id : undefined;

  const key = id
    ? `${role}:id:${id}`
    : toolCallId
      ? `${role}:tool:${toolCallId}`
      : timestamp !== undefined
        ? `${role}:ts:${timestamp}`
        : `${role}:fallback:${fallbackId}`;

  return {
    key,
    role,
    timestamp,
    content: msg.content,
    toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
    toolCallId: toolCallId || undefined,
    isError: msg.isError === true,
  };
}

function getAssistantToolCallIds(msg: RelayMessage): string[] {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall") continue;
    const id =
      typeof b.toolCallId === "string"
        ? b.toolCallId
        : typeof b.id === "string"
          ? b.id
          : "";
    if (id) ids.push(id);
  }
  return ids;
}

function normalizeMessages(rawMessages: unknown[]): RelayMessage[] {
  const all = rawMessages
    .map((m, i) => toRelayMessage(m, `snapshot-${i}`))
    .filter((m): m is RelayMessage => m !== null);

  // Drop no-timestamp assistant messages that are superseded by a later
  // timestamped assistant message. Two messages are considered the same turn
  // when they share at least one toolCallId, OR when the no-timestamp message
  // is immediately followed by a timestamped one (the original heuristic).
  //
  // This prevents streaming partials saved alongside the final message from
  // producing duplicate rows (e.g. thinking blocks appearing below tool cards).

  // Build a set of toolCallIds referenced by any timestamped assistant message.
  const timestampedToolCallIds = new Set<string>();
  for (const msg of all) {
    if (msg.role === "assistant" && msg.timestamp !== undefined) {
      for (const id of getAssistantToolCallIds(msg)) {
        timestampedToolCallIds.add(id);
      }
    }
  }

  const dropIndices = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    if (cur.role !== "assistant" || cur.timestamp !== undefined) continue;

    // Original heuristic: immediately followed by a timestamped assistant message.
    const next = all[i + 1];
    if (next?.role === "assistant" && next.timestamp !== undefined) {
      dropIndices.add(i);
      continue;
    }

    // Extended heuristic: shares a toolCallId with any later timestamped assistant message.
    const ids = getAssistantToolCallIds(cur);
    if (ids.length > 0 && ids.some((id) => timestampedToolCallIds.has(id))) {
      dropIndices.add(i);
    }
  }

  if (dropIndices.size === 0) return all;
  return all.filter((_, i) => !dropIndices.has(i));
}

interface ConfiguredModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

interface TokenUsageInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface ResumeSessionOption {
  id: string;
  path: string;
  name: string | null;
  modified: string;
  firstMessage?: string;
}

export interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

interface SessionUiCacheEntry {
  messages: RelayMessage[];
  activeModel: ConfiguredModelInfo | null;
  sessionName: string | null;
  availableModels: ConfiguredModelInfo[];
  availableCommands: Array<{ name: string; description?: string }>;
  agentActive: boolean;
  effortLevel: string | null;
  tokenUsage: TokenUsageInfo | null;
  lastHeartbeatAt: number | null;
  todoList: TodoItem[];
}

function normalizeModel(raw: unknown): ConfiguredModelInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const model = raw as Record<string, unknown>;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  // Accept both `id` (availableModels shape) and `modelId` (buildSessionContext shape)
  const id = (typeof model.id === "string" ? model.id.trim() : "") ||
              (typeof model.modelId === "string" ? model.modelId.trim() : "");
  if (!provider || !id) return null;

  return {
    provider,
    id,
    name: typeof model.name === "string" ? model.name : undefined,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
  };
}

function normalizeSessionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Inject `durationSeconds` into thinking blocks that we've timed client-side. */
function augmentThinkingDurations(message: unknown, durations: Map<number, number>): unknown {
  if (!message || typeof message !== "object" || durations.size === 0) return message;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return message;
  let changed = false;
  const content = msg.content.map((block, i) => {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "thinking" && durations.has(i) && b.durationSeconds === undefined) {
      changed = true;
      return { ...b, durationSeconds: durations.get(i) };
    }
    return block;
  });
  return changed ? { ...msg, content } : message;
}

function normalizeModelList(rawModels: unknown[]): ConfiguredModelInfo[] {
  const deduped = new Map<string, ConfiguredModelInfo>();
  for (const raw of rawModels) {
    const model = normalizeModel(raw);
    if (!model) continue;
    deduped.set(`${model.provider}/${model.id}`, model);
  }
  return Array.from(deduped.values()).sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

export function App() {
  const { data: session, isPending } = useSession();
  const [isDark, setIsDark] = React.useState(() => {
    const saved = localStorage.getItem("theme");
    return saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<RelayMessage[]>([]);
  const [viewerStatus, setViewerStatus] = React.useState("Idle");
  const [relayStatus, setRelayStatus] = React.useState<DotState>("connecting");
  const [showApiKeys, setShowApiKeys] = React.useState(false);
  const [showRunners, setShowRunners] = React.useState(false);
  const [showTerminal, setShowTerminal] = React.useState(false);
  const [terminalPosition, setTerminalPosition] = React.useState<"bottom" | "right" | "left">(() => {
    try { return (localStorage.getItem("pp-terminal-position") as "bottom" | "right" | "left") ?? "bottom"; } catch { return "bottom"; }
  });
  const [terminalHeight, setTerminalHeight] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-terminal-height");
      if (saved) return Math.max(120, Math.min(parseInt(saved, 10), 900));
    } catch {}
    return 280;
  });
  const [terminalWidth, setTerminalWidth] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-terminal-width");
      if (saved) return Math.max(200, Math.min(parseInt(saved, 10), 1400));
    } catch {}
    return 480;
  });
  const terminalColumnRef = React.useRef<HTMLDivElement>(null);
  // "height" = bottom panel vertical drag, "width-right" = right panel, "width-left" = left panel
  const resizeDir = React.useRef<"height" | "width-right" | "width-left" | null>(null);

  // Single handler — direction is derived from current terminalPosition at drag start
  const handleTerminalResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizeDir.current = terminalPosition === "bottom" ? "height"
      : terminalPosition === "right" ? "width-right"
      : "width-left";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [terminalPosition]);

  const handleTerminalResizeMove = React.useCallback((e: React.PointerEvent) => {
    const dir = resizeDir.current;
    if (!dir || !terminalColumnRef.current) return;
    const rect = terminalColumnRef.current.getBoundingClientRect();
    if (dir === "height") {
      setTerminalHeight(Math.max(120, Math.min(rect.bottom - e.clientY, rect.height - 80)));
    } else if (dir === "width-right") {
      setTerminalWidth(Math.max(200, Math.min(rect.right - e.clientX, rect.width - 200)));
    } else {
      setTerminalWidth(Math.max(200, Math.min(e.clientX - rect.left, rect.width - 200)));
    }
  }, []);

  const handleTerminalResizeEnd = React.useCallback(() => {
    const dir = resizeDir.current;
    if (!dir) return;
    resizeDir.current = null;
    if (dir === "height") {
      setTerminalHeight((h) => { try { localStorage.setItem("pp-terminal-height", String(Math.round(h))); } catch {} return h; });
    } else {
      setTerminalWidth((w) => { try { localStorage.setItem("pp-terminal-width", String(Math.round(w))); } catch {} return w; });
    }
  }, []);

  // Panel drag-to-reposition
  const isPanelDragging = React.useRef(false);
  const panelDragZoneRef = React.useRef<"bottom" | "right" | "left" | null>(null);
  const [panelDragActive, setPanelDragActive] = React.useState(false);
  const [panelDragZone, setPanelDragZone] = React.useState<"bottom" | "right" | "left" | null>(null);

  const handleTerminalPositionChange = React.useCallback((pos: "bottom" | "right" | "left") => {
    setTerminalPosition(pos);
    try { localStorage.setItem("pp-terminal-position", pos); } catch {}
  }, []);

  const handlePanelDragStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isPanelDragging.current = true;
    panelDragZoneRef.current = null;
    setPanelDragActive(true);
    setPanelDragZone(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePanelDragMove = React.useCallback((e: React.PointerEvent) => {
    if (!isPanelDragging.current || !terminalColumnRef.current) return;
    const rect = terminalColumnRef.current.getBoundingClientRect();
    const pctX = (e.clientX - rect.left) / rect.width;
    const pctY = (e.clientY - rect.top) / rect.height;
    let zone: "bottom" | "right" | "left" | null = null;
    if (pctY > 0.55) zone = "bottom";
    else if (pctX > 0.65) zone = "right";
    else if (pctX < 0.35) zone = "left";
    panelDragZoneRef.current = zone;
    setPanelDragZone(zone);
  }, []);

  const handlePanelDragEnd = React.useCallback(() => {
    if (!isPanelDragging.current) return;
    isPanelDragging.current = false;
    const zone = panelDragZoneRef.current;
    panelDragZoneRef.current = null;
    setPanelDragActive(false);
    setPanelDragZone(null);
    if (zone) handleTerminalPositionChange(zone);
  }, [handleTerminalPositionChange]);

  const handleOuterPointerMove = React.useCallback((e: React.PointerEvent) => {
    handleTerminalResizeMove(e);
    handlePanelDragMove(e);
  }, [handleTerminalResizeMove, handlePanelDragMove]);

  const handleOuterPointerUp = React.useCallback(() => {
    handleTerminalResizeEnd();
    handlePanelDragEnd();
  }, [handleTerminalResizeEnd, handlePanelDragEnd]);

  const [showFileExplorer, setShowFileExplorer] = React.useState(false);
  const [filesPosition, setFilesPosition] = React.useState<"left" | "right" | "bottom">(() => {
    try { return (localStorage.getItem("pp-files-position") as "left" | "right" | "bottom") ?? "left"; } catch { return "left"; }
  });
  const [filesWidth, setFilesWidth] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-files-width");
      if (saved) return Math.max(160, Math.min(parseInt(saved, 10), 800));
    } catch {}
    return 280;
  });
  const [filesHeight, setFilesHeight] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-files-height");
      if (saved) return Math.max(150, Math.min(parseInt(saved, 10), 800));
    } catch {}
    return 280;
  });
  const filesContainerRef = React.useRef<HTMLDivElement>(null);
  const filesResizeDir = React.useRef<"width-right" | "width-left" | "height" | null>(null);

  const handleFilesWidthLeftResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    filesResizeDir.current = "width-left";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesWidthRightResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    filesResizeDir.current = "width-right";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesHeightResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    filesResizeDir.current = "height";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesResizeMove = React.useCallback((e: React.PointerEvent) => {
    const dir = filesResizeDir.current;
    if (!dir || !filesContainerRef.current) return;
    const rect = filesContainerRef.current.getBoundingClientRect();
    if (dir === "width-right") {
      setFilesWidth(Math.max(160, Math.min(rect.right - e.clientX, rect.width - 200)));
    } else if (dir === "width-left") {
      setFilesWidth(Math.max(160, Math.min(e.clientX - rect.left, rect.width - 200)));
    } else {
      setFilesHeight(Math.max(150, Math.min(rect.bottom - e.clientY, rect.height - 100)));
    }
  }, []);
  const handleFilesResizeEnd = React.useCallback(() => {
    const dir = filesResizeDir.current;
    if (!dir) return;
    filesResizeDir.current = null;
    if (dir === "height") {
      setFilesHeight((h) => { try { localStorage.setItem("pp-files-height", String(Math.round(h))); } catch {} return h; });
    } else {
      setFilesWidth((w) => { try { localStorage.setItem("pp-files-width", String(Math.round(w))); } catch {} return w; });
    }
  }, []);

  const isFilesDragging = React.useRef(false);
  const filesDragZoneRef = React.useRef<"left" | "right" | "bottom" | null>(null);
  const [filesDragActive, setFilesDragActive] = React.useState(false);
  const [filesDragZone, setFilesDragZone] = React.useState<"left" | "right" | "bottom" | null>(null);

  const handleFilesPositionChange = React.useCallback((pos: "left" | "right" | "bottom") => {
    setFilesPosition(pos);
    try { localStorage.setItem("pp-files-position", pos); } catch {}
  }, []);
  const handleFilesDragStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isFilesDragging.current = true;
    filesDragZoneRef.current = null;
    setFilesDragActive(true);
    setFilesDragZone(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesDragMove = React.useCallback((e: React.PointerEvent) => {
    if (!isFilesDragging.current || !filesContainerRef.current) return;
    const rect = filesContainerRef.current.getBoundingClientRect();
    const pctX = (e.clientX - rect.left) / rect.width;
    const pctY = (e.clientY - rect.top) / rect.height;
    let zone: "left" | "right" | "bottom" | null = null;
    if (pctY > 0.55) zone = "bottom";
    else if (pctX > 0.65) zone = "right";
    else if (pctX < 0.35) zone = "left";
    filesDragZoneRef.current = zone;
    setFilesDragZone(zone);
  }, []);
  const handleFilesDragEnd = React.useCallback(() => {
    if (!isFilesDragging.current) return;
    isFilesDragging.current = false;
    const zone = filesDragZoneRef.current;
    filesDragZoneRef.current = null;
    setFilesDragActive(false);
    setFilesDragZone(null);
    if (zone) handleFilesPositionChange(zone);
  }, [handleFilesPositionChange]);
  const handleFilesOuterPointerMove = React.useCallback((e: React.PointerEvent) => {
    handleFilesResizeMove(e);
    handleFilesDragMove(e);
  }, [handleFilesResizeMove, handleFilesDragMove]);
  const handleFilesOuterPointerUp = React.useCallback(() => {
    handleFilesResizeEnd();
    handleFilesDragEnd();
  }, [handleFilesResizeEnd, handleFilesDragEnd]);

  type RunnerInfo = { runnerId: string; name?: string | null; roots?: string[]; sessionCount: number };
  const [newSessionOpen, setNewSessionOpen] = React.useState(false);
  const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
  const [runnersLoading, setRunnersLoading] = React.useState(false);
  const [spawnRunnerId, setSpawnRunnerId] = React.useState<string | undefined>(undefined);
  const [spawnCwd, setSpawnCwd] = React.useState<string>("");
  const [spawningSession, setSpawningSession] = React.useState(false);
  const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
  const [recentFoldersLoading, setRecentFoldersLoading] = React.useState(false);

  const [pendingQuestion, setPendingQuestion] = React.useState<{ toolCallId: string; question: string; options?: string[] } | null>(null);
  const [activeToolCalls, setActiveToolCalls] = React.useState<Map<string, string>>(new Map());

  // Message queue: messages sent while the agent is active
  type QueuedMessage = { id: string; text: string; deliverAs: "steer" | "followUp"; timestamp: number };
  const [messageQueue, setMessageQueue] = React.useState<QueuedMessage[]>([]);
  const [activeModel, setActiveModel] = React.useState<ConfiguredModelInfo | null>(null);
  const [sessionName, setSessionName] = React.useState<string | null>(null);
  const [availableModels, setAvailableModels] = React.useState<ConfiguredModelInfo[]>([]);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [isChangingModel, setIsChangingModel] = React.useState(false);

  // Live session status from heartbeats
  const [agentActive, setAgentActive] = React.useState(false);
  const [effortLevel, setEffortLevel] = React.useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = React.useState<TokenUsageInfo | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = React.useState<number | null>(null);
  const [providerUsage, setProviderUsage] = React.useState<ProviderUsageMap | null>(null);
  const [todoList, setTodoList] = React.useState<TodoItem[]>([]);

  // Sequence tracking for gap detection
  const lastSeqRef = React.useRef<number | null>(null);

  // Snapshot guard: when connecting to a session, ignore streaming deltas
  // until the initial snapshot (session_active / agent_end / heartbeat) arrives.
  // This prevents pre-snapshot live events from rendering and then being
  // replaced, which causes visible message "jumping".
  const awaitingSnapshotRef = React.useRef(false);

  // Capabilities advertised by the runner (commands, models, etc.)
  const [availableCommands, setAvailableCommands] = React.useState<Array<{ name: string; description?: string }>>([]);

  // /resume picker state (fetched from runner session files)
  const [resumeSessions, setResumeSessions] = React.useState<ResumeSessionOption[]>([]);
  const [resumeSessionsLoading, setResumeSessionsLoading] = React.useState(false);

  // Mobile layout
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [liveSessions, setLiveSessions] = React.useState<HubSession[]>([]);
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = React.useState(false);

  // Auto-reopen the last viewed session once live sessions arrive.
  // (restoredRef is declared here; the effect is placed after openSession is defined below)
  const restoredRef = React.useRef(false);

  // Tracks a session that was restarted via the remote exec "restart" command.
  // When the session comes back live (hub sends session_added), we auto-reconnect.
  const restartPendingSessionIdRef = React.useRef<string | null>(null);
  const restartPendingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prevent the underlying content from scrolling when the mobile sidebar is open.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    if (sidebarOpen) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

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

  React.useEffect(() => {
    if (!newSessionOpen) return;

    let cancelled = false;
    setRunnersLoading(true);
    void fetch("/api/runners", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray((data as any)?.runners) ? (data as any).runners as any[] : [];
        const normalized = list
          .map((r) => ({
            runnerId: typeof r?.runnerId === "string" ? r.runnerId : "",
            name: typeof r?.name === "string" ? r.name : null,
            roots: Array.isArray(r?.roots) ? (r.roots as unknown[]).filter((x): x is string => typeof x === "string") : [],
            sessionCount: typeof r?.sessionCount === "number" ? r.sessionCount : 0,
          }))
          .filter((r) => r.runnerId);
        setRunners(normalized);
      })
      .catch(() => {
        if (cancelled) return;
        setRunners([]);
      })
      .finally(() => {
        if (cancelled) return;
        setRunnersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [newSessionOpen]);

  const viewerWsRef = React.useRef<Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null>(null);
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
      effortLevel: prev?.effortLevel ?? null,
      tokenUsage: prev?.tokenUsage ?? null,
      lastHeartbeatAt: prev?.lastHeartbeatAt ?? null,
      todoList: prev?.todoList ?? [],
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

  // Track wall-clock timing of thinking blocks so we can bake duration into the content.
  // contentIndex → Date.now() at thinking_start
  const thinkingStartTimesRef = React.useRef<Map<number, number>>(new Map());
  // contentIndex → elapsed seconds at thinking_end
  const thinkingDurationsRef = React.useRef<Map<number, number>>(new Map());

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.setItem("theme", isDark ? "dark" : "light");
  }, [isDark]);

  React.useEffect(() => {
    return () => {
      viewerWsRef.current?.disconnect();
      viewerWsRef.current = null;
    };
  }, []);

  const clearSelection = React.useCallback(() => {
    viewerWsRef.current?.disconnect();
    viewerWsRef.current = null;
    activeSessionRef.current = null;
    lastSeqRef.current = null;
    awaitingSnapshotRef.current = false;
    setActiveSessionId(null);
    setMessages([]);
    setViewerStatus("Idle");
    setPendingQuestion(null);
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
    setTokenUsage(null);
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
          for (const { raw: pendingRaw, key } of pending.values()) {
            let msg = toRelayMessage(pendingRaw, key);
            if (!msg) continue;

            // Try to find an existing message by key
            let idx = result.findIndex((m) => m.key === msg!.key);

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
            }
          }
          return result;
        });
      });
    }
  }, []);

  const appendLocalSystemMessage = React.useCallback((text: string) => {
    const content = text.trim();
    if (!content) return;

    const now = Date.now();
    const message: RelayMessage = {
      key: `system:local:${now}:${Math.random().toString(16).slice(2)}`,
      role: "system",
      timestamp: now,
      content,
    };

    setMessages((prev) => {
      const next = [...prev, message];
      patchSessionCache({ messages: next });
      return next;
    });
  }, [patchSessionCache]);

  const handleRelayEvent = React.useCallback((event: unknown, seq?: number) => {
    if (!event || typeof event !== "object") return;

    const evt = event as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";

    // Clear the snapshot guard when we receive a state-setting event.
    // These events replace the entire message list, so any pre-snapshot
    // deltas that snuck through are harmless (they'll be overwritten).
    if (type === "session_active" || type === "agent_end" || type === "heartbeat") {
      awaitingSnapshotRef.current = false;
    }

    // While awaiting the initial snapshot, skip streaming delta events.
    // They'd render briefly and then be replaced when the snapshot arrives,
    // causing visible "jumping".
    if (awaitingSnapshotRef.current) {
      if (type === "message_update" || type === "message_start" || type === "message_end" || type === "turn_end") {
        return;
      }
    }

    if (type === "heartbeat") {
      const hb = evt as {
        active?: boolean;
        model?: { provider: string; id: string; name?: string } | null;
        sessionName?: string | null;
        thinkingLevel?: string | null;
        tokenUsage?: TokenUsageInfo | null;
        ts?: number;
      };

      const nextAgentActive = hb.active === true;
      const cachePatch: Partial<SessionUiCacheEntry> = {
        agentActive: nextAgentActive,
      };

      setAgentActive(nextAgentActive);

      if (hb.thinkingLevel !== undefined) {
        const next = hb.thinkingLevel ?? null;
        setEffortLevel(next);
        cachePatch.effortLevel = next;
      }

      if (hb.tokenUsage !== undefined) {
        const next = hb.tokenUsage ?? null;
        setTokenUsage(next);
        cachePatch.tokenUsage = next;
      }

      if (typeof hb.ts === "number") {
        setLastHeartbeatAt(hb.ts);
        cachePatch.lastHeartbeatAt = hb.ts;
      }

      if ((hb as any).providerUsage !== undefined) {
        setProviderUsage((hb as any).providerUsage ?? null);
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
        const pq = (hb as any).pendingQuestion as { toolCallId: string; question: string; options?: string[] } | null;
        if (pq && typeof pq.question === "string" && pq.question.trim()) {
          setPendingQuestion({
            toolCallId: typeof pq.toolCallId === "string" ? pq.toolCallId : "ask-user-question",
            question: pq.question.trim(),
            options: Array.isArray(pq.options) ? (pq.options as unknown[]).filter((o): o is string => typeof o === "string") : undefined,
          });
          setViewerStatus("Waiting for answer…");
        } else {
          // Heartbeat explicitly says no pending question; clear any stale state.
          setPendingQuestion(null);
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
        .map((c) => ({ name: String(c.name), description: typeof c.description === "string" ? c.description : undefined }))
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

      // Don't clobber a transient status like "Model set" with a generic
      // "Connected" when the CLI sends a session_active snapshot right after.
      setViewerStatus((prev) => (prev === "Model set" ? prev : "Connected"));

      setPendingQuestion(null);
      setIsChangingModel(false);

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

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      const normalized = normalizeMessages(evt.messages as unknown[]);
      cancelPendingDeltas();
      setMessages(normalized);
      patchSessionCache({ messages: normalized });
      setPendingQuestion(null);
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
        setViewerStatus(`/${command}: ${error}`);
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
        const lines = Array.isArray(result?.lines)
          ? result.lines.filter((line: unknown): line is string => typeof line === "string")
          : [];
        if (lines.length > 0) {
          appendLocalSystemMessage(lines.join("\n"));
        }

        const summary = typeof result?.summary === "string"
          ? result.summary
          : typeof result?.toolCount === "number"
            ? `MCP tools loaded: ${result.toolCount}`
            : "MCP status updated";
        setViewerStatus(summary);
        return;
      }

      if (command === "cycle_thinking_level" || command === "set_thinking_level") {
        const newLevel = typeof result?.thinkingLevel === "string" ? result.thinkingLevel : null;
        setEffortLevel(newLevel);
        patchSessionCache({ effortLevel: newLevel });
        setViewerStatus(newLevel && newLevel !== "off" ? `Effort: ${newLevel}` : "Effort: off");
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
        setViewerStatus("Compacted");
        return;
      }

      if (command === "new_session") {
        cancelPendingDeltas();
        setMessages([]);
        setPendingQuestion(null);
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
          return next;
        });
      }
    }

    if (type === "tool_execution_end") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      if (toolCallId) {
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.delete(toolCallId);
          return next;
        });
      }
    }

    if (type === "tool_execution_start" && evt.toolName === "AskUserQuestion") {
      const args = evt.args as Record<string, unknown> | undefined;
      const question = typeof args?.question === "string" ? args.question.trim() : "";
      const rawOptions = Array.isArray(args?.options) ? args.options : undefined;
      const options = rawOptions ? (rawOptions as unknown[]).filter((o): o is string => typeof o === "string") : undefined;

      if (question) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : "ask-user-question",
          question,
          options,
        });
        setViewerStatus("Waiting for answer…");
      }
      return;
    }

    if (type === "tool_execution_update" && evt.toolName === "AskUserQuestion") {
      const partial = evt.partialResult as Record<string, unknown> | undefined;
      const details = partial?.details as Record<string, unknown> | undefined;
      const rawQuestion = typeof partial?.question === "string"
        ? partial.question
        : typeof details?.question === "string"
          ? details.question
          : "";
      const question = rawQuestion.trim();

      const rawOptions = (Array.isArray(partial?.options) ? partial.options : undefined)
        ?? (Array.isArray(details?.options) ? details.options : undefined);
      const options = rawOptions ? (rawOptions as unknown[]).filter((o): o is string => typeof o === "string") : undefined;

      if (question) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : "ask-user-question",
          question,
          options,
        });
      }
      return;
    }

    if (type === "tool_execution_end" && evt.toolName === "AskUserQuestion") {
      setPendingQuestion(null);
      setViewerStatus("Connected");
      return;
    }

    if (type === "agent_end") {
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
    }

    if (type === "message_end" || type === "turn_end") {
      upsertMessage(augmentThinkingDurations(evt.message, thinkingDurationsRef.current), type, true);
      // Reset for the next assistant message.
      thinkingStartTimesRef.current = new Map();
      thinkingDurationsRef.current = new Map();
    }
  }, [upsertMessage, upsertMessageDebounced, cancelPendingDeltas, appendLocalSystemMessage]);

  const openSession = React.useCallback((relaySessionId: string) => {
    viewerWsRef.current?.disconnect();
    viewerWsRef.current = null;

    localStorage.setItem("pp.lastSessionId", relaySessionId);
    activeSessionRef.current = relaySessionId;
    lastSeqRef.current = null;
    awaitingSnapshotRef.current = true;
    setActiveSessionId(relaySessionId);
    setViewerStatus("Connecting…");
    setPendingQuestion(null);
    setActiveToolCalls(new Map());
    setIsChangingModel(false);
    setResumeSessions([]);
    setResumeSessionsLoading(false);

    const cached = sessionUiCacheRef.current.get(relaySessionId);
    setMessages(cached?.messages ?? []);
    setActiveModel(cached?.activeModel ?? null);
    setSessionName(cached?.sessionName ?? null);
    setAvailableModels(cached?.availableModels ?? []);
    setAvailableCommands(cached?.availableCommands ?? []);
    setAgentActive(cached?.agentActive ?? false);
    setEffortLevel(cached?.effortLevel ?? null);
    setTokenUsage(cached?.tokenUsage ?? null);
    setLastHeartbeatAt(cached?.lastHeartbeatAt ?? null);
    setTodoList(cached?.todoList ?? []);

    const socket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> = io("/viewer", {
      auth: { sessionId: relaySessionId },
      withCredentials: true,
    });
    viewerWsRef.current = socket;

    socket.on("connected", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;

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

      // Detect sequence gaps; request a resync if we missed events.
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
      handleRelayEvent({ type: "exec_result", ...data });
    });

    socket.on("disconnected", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      const isRestarting = restartPendingSessionIdRef.current === relaySessionId;
      if (!isRestarting) {
        setViewerStatus(data.reason || "Disconnected");
      }
      setPendingQuestion(null);
      setIsChangingModel(false);
    });

    socket.on("error", (data) => {
      if (activeSessionRef.current !== relaySessionId) return;
      setViewerStatus(data.message || "Failed to load session");
    });

    socket.on("connect_error", () => {
      if (activeSessionRef.current === relaySessionId) {
        setViewerStatus("Connection error");
      }
    });

    socket.on("disconnect", () => {
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
        setIsChangingModel(false);
      }
    });
  }, [handleRelayEvent, patchSessionCache]);

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



  const sendSessionInput = React.useCallback(async (message: { text: string; files?: Array<{ mediaType?: string; filename?: string; url?: string }>; deliverAs?: "steer" | "followUp" } | string) => {
    const socket = viewerWsRef.current;
    const sessionId = activeSessionRef.current;
    if (!socket || !socket.connected || !sessionId) {
      setViewerStatus("Not connected to a live session");
      return false;
    }

    const payload = typeof message === "string" ? { text: message, files: [] } : message;
    const trimmed = payload.text.trim();

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
            return false;
          }

          const body = await uploadRes.json().catch(() => null) as any;
          const first = Array.isArray(body?.attachments) ? body.attachments[0] : null;
          if (!first || typeof first.attachmentId !== "string") {
            setViewerStatus(`Upload failed for ${displayName}`);
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

    // Non-active session: open a temporary viewer socket, fire the exec, disconnect
    const tempSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> = io("/viewer", {
      auth: { sessionId },
      withCredentials: true,
    });

    const cleanup = () => tempSocket.disconnect();
    const timeout = setTimeout(cleanup, 10_000);

    tempSocket.on("connected", () => {
      clearTimeout(timeout);
      tempSocket.emit("exec", {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: "end_session",
      } as any);
      // Give the exec a moment to reach the runner before disconnecting
      setTimeout(cleanup, 500);
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

  const removeQueuedMessage = React.useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
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

  const handleNewSession = React.useCallback(() => {
    setSpawnRunnerId(undefined);
    setSpawnCwd("");
    setRecentFolders([]);
    setNewSessionOpen(true);
  }, []);

  const waitForSessionToGoLive = React.useCallback(async (sessionId: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch("/api/sessions", { credentials: "include" });
        if (res.ok) {
          const body = await res.json().catch(() => null) as any;
          const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
          const live = sessions.some((s: any) => typeof s?.sessionId === "string" && s.sessionId === sessionId);
          if (live) return true;
        }
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }, []);

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

  if (isPending) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center bg-background gap-2 animate-in fade-in duration-300">
        <Spinner className="size-8 text-primary/60" />
      </div>
    );
  }

  if (!session) {
    return <AuthPage onAuthenticated={() => authClient.$store.notify("$sessionSignal")} />;
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
  const modelGroups = new Map<string, ConfiguredModelInfo[]>();
  for (const model of availableModels) {
    if (!modelGroups.has(model.provider)) modelGroups.set(model.provider, []);
    modelGroups.get(model.provider)!.push(model);
  }

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background pp-safe-left pp-safe-right">
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
          {providerUsage && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <UsageIndicator usage={providerUsage} />
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setIsDark((d) => !d)}
            aria-label="Toggle dark mode"
            title="Toggle dark mode"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          <NotificationToggle />

          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => { setShowApiKeys(true); setShowRunners(false); }}
            aria-label="Manage API keys"
            title="Manage API keys"
          >
            <KeyRound className="h-4 w-4" />
          </Button>

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
        {/* Left: sidebar toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
        >
          <PanelLeftOpen className="h-5 w-5" />
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
          {providerUsage && (
            <div className="hidden xs:flex">
              <UsageIndicator usage={providerUsage} />
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
                  {initials(userLabel)}
                </span>
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
              {providerUsage && (
                <div className="px-2 py-1.5 border-t border-border/50">
                  <UsageIndicator usage={providerUsage} />
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setIsDark((d) => !d)}>
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {isDark ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <MobileNotificationMenuItem />
              <DropdownMenuItem onSelect={() => { setShowApiKeys(true); setShowRunners(false); setSidebarOpen(false); }}>
                <KeyRound className="h-4 w-4" />
                API keys
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setShowRunners(true); setShowApiKeys(false); setActiveSessionId(null); setSidebarOpen(false); }}>
                <HardDrive className="h-4 w-4" />
                Runners
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
          <ModelSelectorList>
            <ModelSelectorEmpty>No configured models available.</ModelSelectorEmpty>
            {Array.from(modelGroups.entries()).map(([provider, models]) => (
              <ModelSelectorGroup key={provider} heading={provider}>
                {models.map((model) => {
                  const modelKey = `${model.provider}/${model.id}`;
                  const isActive = modelKey === activeModelKey;
                  return (
                    <ModelSelectorItem
                      key={modelKey}
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
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>

      <div className="pp-shell flex flex-1 min-h-0 overflow-hidden relative">
        <div
          className={
            "pp-sidebar-wrap absolute inset-y-0 left-0 z-40 w-72 max-w-[85vw] border-r border-sidebar-border bg-sidebar shadow-2xl md:static md:z-auto md:w-auto md:max-w-none md:border-r-0 md:bg-transparent md:shadow-none transition-transform duration-200 ease-in-out md:transition-none will-change-transform " +
            (sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0")
          }
        >
          <SessionSidebar
            onOpenSession={handleOpenSession}
            onNewSession={handleNewSession}
            onClearSelection={handleClearSelection}
            onShowRunners={() => { setShowRunners(true); setShowApiKeys(false); setActiveSessionId(null); setSidebarOpen(false); }}
            activeSessionId={activeSessionId}
            showRunners={showRunners}
            activeModel={activeModel}
            onRelayStatusChange={setRelayStatus}
            onSessionsChange={setLiveSessions}
            onClose={() => setSidebarOpen(false)}
            onEndSession={handleEndSession}
          />
        </div>

        {/* Mobile overlay — fades in/out with the sidebar */}
        <div
          className={cn(
            "pp-sidebar-overlay absolute inset-0 z-30 bg-black/50 md:hidden transition-opacity duration-200",
            sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          )}
          onClick={() => setSidebarOpen(false)}
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
          {showFileExplorer && activeSessionInfo?.runnerId && activeSessionInfo?.cwd && (
            <>
              {/* Mobile: full-screen overlay */}
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
            <div className={cn(
              "flex flex-col flex-1 min-h-0",
              showTerminal && "overflow-hidden",
              showTerminal && terminalPosition !== "bottom" && "min-w-0",
              showTerminal && terminalPosition === "left" && "order-last",
            )}>
              {showRunners ? (
                <RunnerManager onOpenSession={(id) => { handleOpenSession(id); setShowRunners(false); }} />
              ) : (
                <SessionViewer
                  sessionId={activeSessionId}
                  sessionName={sessionName}
                  messages={messages}
                  activeModel={activeModel}
                  activeToolCalls={activeToolCalls}
                  pendingQuestion={pendingQuestion}
                  availableCommands={availableCommands}
                  resumeSessions={resumeSessions}
                  resumeSessionsLoading={resumeSessionsLoading}
                  onRequestResumeSessions={requestResumeSessions}
                  onSendInput={sendSessionInput}
                  onExec={sendRemoteExec}
                  onShowModelSelector={() => setModelSelectorOpen(true)}
                  agentActive={agentActive}
                  effortLevel={effortLevel}
                  tokenUsage={tokenUsage}
                  lastHeartbeatAt={lastHeartbeatAt}
                  viewerStatus={viewerStatus}
                  messageQueue={messageQueue}
                  onRemoveQueuedMessage={removeQueuedMessage}
                  onClearMessageQueue={clearMessageQueue}
                  onToggleTerminal={() => setShowTerminal((v) => !v)}
                  showTerminalButton
                  onToggleFileExplorer={() => setShowFileExplorer((v) => !v)}
                  showFileExplorerButton={!!activeSessionInfo?.runnerId && !!activeSessionInfo?.cwd}
                  todoList={todoList}
                />
              )}
            </div>
            {showTerminal && (
              <>
                {/* Mobile: full-screen overlay */}
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
                  />
                </div>

                {/*
                  Desktop: single always-mounted instance so xterm state survives position changes.
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
                    position={terminalPosition}
                    onPositionChange={handleTerminalPositionChange}
                    onDragStart={handlePanelDragStart}
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

        <Dialog open={newSessionOpen} onOpenChange={(open) => { if (!spawningSession) setNewSessionOpen(open); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New session</DialogTitle>
              <DialogDescription>
                Spawn a new headless PizzaPi session on a connected runner.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="pp-runner">Runner</Label>
                <Select value={spawnRunnerId} onValueChange={setSpawnRunnerId}>
                  <SelectTrigger id="pp-runner" className="w-full">
                    <SelectValue placeholder={runnersLoading ? "Loading…" : "Select a runner"} />
                  </SelectTrigger>
                  <SelectContent>
                    {runners.map((r) => {
                      const label = (r.name && r.name.trim()) ? r.name.trim() : `${r.runnerId.slice(0, 8)}…`;
                      const roots = Array.isArray(r.roots) ? r.roots : [];
                      const rootsLabel = roots.length > 0 ? ` · ${roots.length} root${roots.length === 1 ? "" : "s"}` : "";
                      return (
                        <SelectItem key={r.runnerId} value={r.runnerId}>
                          {label} ({r.sessionCount} sessions{rootsLabel})
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {runnersLoading && (
                  <div className="text-xs text-muted-foreground inline-flex items-center gap-2">
                    <Spinner className="size-3" /> Loading runners…
                  </div>
                )}
                {!runnersLoading && runners.length === 0 && (
                  <div className="text-xs text-destructive">
                    No runners connected. Start one with <code className="px-1">pizzapi runner</code>.
                  </div>
                )}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="pp-cwd">Working directory</Label>
                <Input
                  id="pp-cwd"
                  value={spawnCwd}
                  onChange={(e) => setSpawnCwd(e.target.value)}
                  placeholder="/path/to/project"
                  disabled={spawningSession}
                />
                <div className="text-xs text-muted-foreground">
                  This is the path on the runner machine.
                </div>
                {recentFoldersLoading && (
                  <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                    <Spinner className="size-3" /> Loading recent folders…
                  </div>
                )}
                {!recentFoldersLoading && recentFolders.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Recent</span>
                    <div className="flex flex-wrap gap-1.5">
                      {recentFolders.map((folder) => (
                        <button
                          key={folder}
                          type="button"
                          disabled={spawningSession}
                          onClick={() => setSpawnCwd(folder)}
                          className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[11px] transition-colors
                            ${spawnCwd === folder
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-muted/50 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                            }`}
                          title={folder}
                        >
                          <span className="max-w-[220px] truncate">{folder}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              <div className="flex-1 text-xs text-muted-foreground">
                {!spawnRunnerId ? "Pick a runner." : ""}
              </div>
              <Button variant="outline" onClick={() => setNewSessionOpen(false)} disabled={spawningSession}>
                Cancel
              </Button>
              <Button onClick={spawnNewRunnerSession} disabled={spawningSession || runners.length === 0 || !spawnRunnerId}>
                {spawningSession ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Spawning…
                  </span>
                ) : (
                  "Spawn"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {showApiKeys && (
          <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">API Keys</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowApiKeys(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex flex-col gap-4">
                <ApiKeyManager />
                <RunnerTokenManager />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
