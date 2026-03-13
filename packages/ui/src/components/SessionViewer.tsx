import * as React from "react";

import {
  ConversationDownload,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import type { RelayMessage } from "@/components/session-viewer/types";
import { SessionActionsProvider, type SessionActions } from "@/components/session-viewer/session-actions-context";
import { groupToolExecutionMessages, groupSubAgentConversations } from "@/components/session-viewer/grouping";
import { getComposerSubmitMode } from "@/components/session-viewer/composer-submit-state";
import {
  hasVisibleContent,
  normalizeToolName,
  resolveCommandPopoverState,
} from "@/components/session-viewer/utils";
import {
  renderContent,
  roleLabel,
  toMessageRole,
  CompactionSummaryCard,
  CommandResultCard,
  isCommandResult,
  type CommandResultData,
} from "@/components/session-viewer/rendering";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { ProviderIcon } from "@/components/ProviderIcon";
import { MultipleChoiceQuestions } from "@/components/ai-elements/multiple-choice";
import { PlanModePanel, type PlanModeAnswer } from "@/components/ai-elements/plan-mode";
import { formatAnswersForAgent, type QuestionDisplayMode } from "@/lib/ask-user-questions";
import { dismissNotificationsForSession } from "@/lib/push";
import { AlertTriangleIcon, ArrowDownIcon, BookOpen, Bot, CheckCircle2, ChevronsUpDown, Circle, CircleDashed, Loader2, MessageSquare, OctagonX, PaperclipIcon, Plus, Puzzle, ShieldAlert, Zap, Clock, X, Trash2, TerminalIcon, DownloadIcon, XCircle, FolderTree } from "lucide-react";
import { AtMentionPopover } from "@/components/AtMentionPopover";
import type { Entry as AtMentionEntry } from "@/hooks/useAtMentionFiles";
import { McpToggleContext, type McpToggleHandler } from "@/components/session-viewer/McpToggleContext";

export type { RelayMessage } from "@/components/session-viewer/types";

export interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

export interface TokenUsage {
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

export interface QueuedMessage {
  id: string;
  text: string;
  deliverAs: "steer" | "followUp";
  timestamp: number;
}

export interface SessionViewerProps {
  sessionId: string | null;
  sessionName?: string | null;
  messages: RelayMessage[];
  /** Active model info for the current session (used to show provider indicator) */
  activeModel?: { provider: string; id: string; name?: string; reasoning?: boolean } | null;
  activeToolCalls?: Map<string, string>;
  pendingQuestion?: { toolCallId: string; questions: Array<{ question: string; options: string[] }>; display: QuestionDisplayMode } | null;
  /** Pending plan mode prompt — shown as a plan review panel */
  pendingPlan?: { toolCallId: string; title: string; description: string | null; steps: Array<{ title: string; description?: string }> } | null;
  /** Plugin trust prompt from the worker — shown as a confirmation dialog */
  pluginTrustPrompt?: { promptId: string; pluginNames: string[]; pluginSummaries: string[] } | null;
  /** Respond to the plugin trust prompt */
  onPluginTrustResponse?: (trusted: boolean) => void;
  availableCommands?: Array<{ name: string; description?: string; source?: string }>;
  resumeSessions?: ResumeSessionOption[];
  resumeSessionsLoading?: boolean;
  onRequestResumeSessions?: () => boolean | void;
  onSendInput?: (message: PromptInputMessage & { deliverAs?: "steer" | "followUp" } | string) => boolean | void | Promise<boolean | void>;
  onExec?: (payload: unknown) => boolean | void;
  onShowModelSelector?: () => void;
  /** Whether the agent is currently processing a turn */
  agentActive?: boolean;
  /** Whether the session is currently being compacted */
  isCompacting?: boolean;
  /** Current reasoning effort level (e.g. "low", "medium", "high", "off") */
  effortLevel?: string | null;

  /** Cumulative token usage for the session */
  tokenUsage?: TokenUsage | null;
  /** Unix ms timestamp of the most recent heartbeat from the CLI */
  lastHeartbeatAt?: number | null;
  /** Human-readable connection/activity status */
  viewerStatus?: string;
  /** Auto-retry state from the CLI (provider error being retried) */
  retryState?: { errorMessage: string; detectedAt: number } | null;
  /** Messages queued while the agent is active */
  messageQueue?: QueuedMessage[];
  /** Remove a single queued message */
  onRemoveQueuedMessage?: (id: string) => void;
  /** Clear all queued messages */
  onClearMessageQueue?: () => void;
  /** Toggle the terminal panel */
  onToggleTerminal?: () => void;
  /** Whether to show the terminal button */
  showTerminalButton?: boolean;
  /** Toggle the file explorer panel */
  onToggleFileExplorer?: () => void;
  /** Whether to show the file explorer button */
  showFileExplorerButton?: boolean;
  /** Current agent todo list */
  todoList?: TodoItem[];
  /** Whether plan mode (read-only exploration) is currently active */
  planModeEnabled?: boolean;
  /** Runner ID for the current session (used for runner files API) */
  runnerId?: string;
  /** Absolute working directory of the current session (used as base for @-mention file paths) */
  sessionCwd?: string;
  /** Append a local system message to the conversation (string or structured data for card rendering) */
  onAppendSystemMessage?: (content: string | CommandResultData) => void;
  /** Spawn a new session configured as a specific agent */
  onSpawnAgentSession?: (agent: { name: string; description?: string; systemPrompt?: string; tools?: string; disallowedTools?: string }) => void;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function HeartbeatStaleBadge({ lastHeartbeatAt }: { lastHeartbeatAt: number | null | undefined }) {
  const [stale, setStale] = React.useState(false);

  React.useEffect(() => {
    if (!lastHeartbeatAt) { setStale(false); return; }
    const check = () => setStale(Date.now() - lastHeartbeatAt > 35_000);
    check();
    const timer = setInterval(check, 5_000);
    return () => clearInterval(timer);
  }, [lastHeartbeatAt]);

  if (!stale) return null;
  return (
    <span className="text-[0.65rem] text-amber-400/80" title="No heartbeat received in the last 35 seconds — CLI may be disconnected">
      ⚠ stale
    </span>
  );
}

function ComposerAttachmentMeta({
  file,
}: {
  file: { url?: string; mediaType?: string };
}) {
  const [sizeLabel, setSizeLabel] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    const url = file.url;
    if (!url) {
      setSizeLabel("");
      return;
    }

    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        if (!cancelled) setSizeLabel(formatFileSize(blob.size));
      })
      .catch(() => {
        if (!cancelled) setSizeLabel("");
      });

    return () => {
      cancelled = true;
    };
  }, [file.url]);

  return (
    <div className="min-w-0 max-w-48 text-[10px] text-muted-foreground">
      <span className="truncate block">
        {sizeLabel || "size unknown"}
        {file.mediaType ? ` · ${file.mediaType}` : ""}
      </span>
    </div>
  );
}

function ComposerAttachments() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <div className="px-2 pb-2">
      <Attachments variant="inline" className="w-full gap-1.5">
        {attachments.files.map((file) => (
          <Attachment
            key={file.id}
            data={file}
            onRemove={() => attachments.remove(file.id)}
          >
            <AttachmentPreview />
            <div className="min-w-0 max-w-56">
              <span className="block truncate text-xs">{file.filename || "Attachment"}</span>
              <ComposerAttachmentMeta file={file} />
            </div>
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </div>
  );
}

function ComposerAttachmentButton() {
  const attachments = usePromptInputAttachments();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground"
      onClick={() => attachments.openFileDialog()}
      title="Add attachments"
      aria-label="Add attachments"
    >
      <PaperclipIcon className="size-4" />
    </Button>
  );
}

function ComposerSubmitButton({
  sessionId,
  input,
  agentActive,
  onExec,
  isTouchDevice,
}: {
  sessionId: string | null;
  input: string;
  agentActive?: boolean;
  onExec?: (payload: unknown) => boolean | void;
  isTouchDevice?: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const hasAttachments = attachments.files.length > 0;
  const hasDraft = input.trim().length > 0 || hasAttachments;
  const submitMode = getComposerSubmitMode({
    isTouchDevice: Boolean(isTouchDevice),
    agentActive: Boolean(agentActive),
    hasDraft,
    canAbort: Boolean(agentActive && onExec),
  });

  if (submitMode === "hidden") {
    return null;
  }

  const showStopMode = submitMode === "stop";

  return (
    <PromptInputSubmit
      status={showStopMode ? "streaming" : "ready"}
      onStop={
        showStopMode && onExec
          ? () => {
              onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "abort" });
            }
          : undefined
      }
      disabled={!sessionId || (!showStopMode && !hasDraft)}
    />
  );
}

const SessionMessageItem = React.memo(({ message, activeToolCalls, agentActive, isLast }: {
  message: RelayMessage;
  activeToolCalls?: Map<string, string>;
  agentActive?: boolean;
  isLast: boolean;
}) => {
  // System messages with structured command result data render as standalone cards
  if (message.role === "system" && isCommandResult(message.content)) {
    return (
      <div className="w-full px-4 py-1.5 max-w-3xl mx-auto">
        <CommandResultCard data={message.content} />
      </div>
    );
  }

  // Compaction summary cards render as standalone elements without the message wrapper
  if ((message.role === "compactionSummary" || message.role === "branchSummary") && message.summary) {
    return (
      <div className="w-full px-4 py-1.5 max-w-3xl mx-auto">
        <CompactionSummaryCard
          summary={message.summary}
          tokensBefore={message.tokensBefore}
        />
      </div>
    );
  }

  // Chromeless tool cards — render as standalone inline elements without the
  // outer "TOOL · NAME · timestamp" message wrapper.
  if ((message.role === "toolResult" || message.role === "tool") && message.toolInput !== undefined) {
    const norm = normalizeToolName(message.toolName);
    if (norm === "toggle_plan_mode" || norm.endsWith(".toggle_plan_mode")) {
      return (
        <div className="w-full px-4 py-1.5 max-w-3xl mx-auto">
          {renderContent(
            message.content,
            activeToolCalls,
            message.role,
            message.toolName,
            message.isError,
            message.toolInput,
            message.toolCallId ?? message.key,
            agentActive && isLast && message.timestamp === undefined,
            message.thinking,
            message.thinkingDuration,
            undefined,
            message.details,
          )}
        </div>
      );
    }
  }

  // Sub-agent conversation cards render without the outer message wrapper
  // (they have their own full-width card styling)
  if (message.role === "subAgentConversation") {
    return (
      <div className="w-full px-4 py-1.5 max-w-3xl mx-auto">
        {renderContent(
          message.content,
          activeToolCalls,
          message.role,
          message.toolName,
          message.isError,
          message.toolInput,
          message.toolCallId ?? message.key,
          agentActive && isLast && message.timestamp === undefined,
          message.thinking,
          message.thinkingDuration,
          message.subAgentTurns,
          message.details,
        )}
      </div>
    );
  }

  return (
    <div className="w-full px-4 py-1.5">
      <Message from={toMessageRole(message.role)}>
        <MessageContent
          className={cn(
            "pp-message-content max-w-3xl min-w-0 rounded-lg border px-3 py-2",
            message.role === "user"
              ? "ml-auto bg-primary text-primary-foreground border-primary/40"
              : "w-full bg-card text-card-foreground border-border",
          )}
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide opacity-70">
            <span>{roleLabel(message.role)}</span>
            {message.toolName && <span>• {message.toolName}</span>}
            {message.timestamp && <span>• {new Date(message.timestamp).toLocaleTimeString()}</span>}
            {message.isError && <span className="text-destructive">• Error</span>}
          </div>
          {renderContent(
            message.content,
            activeToolCalls,
            message.role,
            message.toolName,
            message.isError,
            message.toolInput,
            message.toolCallId ?? message.key,
            // Only treat thinking as still-streaming when the agent is active,
            // this is the last message, AND the message has no timestamp yet
            // (timestamped messages are finalized even if a heartbeat hasn't
            // confirmed agentActive=false yet).
            agentActive && isLast && message.timestamp === undefined,
            message.thinking,
            message.thinkingDuration,
            undefined, // subAgentTurns
            message.details,
          )}
          {message.stopReason === "error" && message.errorMessage && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{message.errorMessage}</span>
            </div>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}, (prev, next) => {
  // If message object changed (e.g. streaming update), must re-render.
  if (prev.message !== next.message) return false;
  
  // If isLast status changed, must re-render (e.g. to show/hide thinking spinner).
  if (prev.isLast !== next.isLast) return false;
  
  // If agentActive changed AND this is the last message (which might show spinner), re-render.
  if ((prev.isLast || next.isLast) && prev.agentActive !== next.agentActive) return false;

  // If activeToolCalls map changed reference, re-render only if strict equality fails.
  // Since we can't easily deep-check if the map change affects *this* message without
  // expensive logic, we'll err on the side of correctness.
  // Note: activeToolCalls only changes on tool start/end, which is rare compared to text tokens.
  if (prev.activeToolCalls !== next.activeToolCalls) return false;

  return true;
});

function SessionSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-4 max-w-3xl mx-auto w-full animate-in fade-in duration-700">
      <div className="flex flex-col items-end gap-1 opacity-40">
        <Skeleton className="h-10 w-1/2 rounded-2xl rounded-br-sm" />
      </div>
      <div className="flex flex-col items-start gap-1 opacity-40">
        <div className="flex items-center gap-2 mb-1 px-1">
             <Skeleton className="h-2.5 w-12 rounded-sm" />
             <Skeleton className="h-2.5 w-2.5 rounded-full" />
             <Skeleton className="h-2.5 w-20 rounded-sm" />
        </div>
        <Skeleton className="h-24 w-3/4 rounded-2xl rounded-bl-sm" />
      </div>
       <div className="flex flex-col items-end gap-1 opacity-30 delay-100">
        <Skeleton className="h-16 w-1/3 rounded-2xl rounded-br-sm" />
      </div>
    </div>
  );
}

export function SessionViewer({ sessionId, sessionName, messages, activeModel, activeToolCalls, pendingQuestion, pendingPlan, pluginTrustPrompt, onPluginTrustResponse, availableCommands, resumeSessions, resumeSessionsLoading, onRequestResumeSessions, onSendInput, onExec, onShowModelSelector, agentActive, isCompacting, effortLevel, tokenUsage, lastHeartbeatAt, viewerStatus, retryState, messageQueue, onRemoveQueuedMessage, onClearMessageQueue, onToggleTerminal, showTerminalButton, onToggleFileExplorer, showFileExplorerButton, todoList = [], planModeEnabled, runnerId, sessionCwd, onAppendSystemMessage, onSpawnAgentSession }: SessionViewerProps) {
  const [input, setInput] = React.useState("");
  const [composerError, setComposerError] = React.useState<string | null>(null);
  const [showClearDialog, setShowClearDialog] = React.useState(false);
  const [showEndSessionDialog, setShowEndSessionDialog] = React.useState(false);
  // Delivery mode for messages sent while agent is active: "steer" interrupts, "followUp" waits
  const [deliveryMode, setDeliveryMode] = React.useState<"steer" | "followUp">("followUp");

  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");
  const [commandHighlightedIndex, setCommandHighlightedIndex] = React.useState(0);

  // Dismiss push notifications when a pending question is visible in-app.
  // This prevents stale notifications from injecting answers after the user
  // has already seen (or answered) the question in the UI.
  React.useEffect(() => {
    if (pendingQuestion && sessionId) {
      void dismissNotificationsForSession(sessionId);
    }
  }, [pendingQuestion, sessionId]);

  // Detect touch devices for mobile-specific behavior
  const isTouchDevice = React.useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  // @-mention popover state
  const [atMentionOpen, setAtMentionOpen] = React.useState(false);
  const [atMentionPath, setAtMentionPath] = React.useState("");
  const [atMentionQuery, setAtMentionQuery] = React.useState("");
  const [atMentionTriggerOffset, setAtMentionTriggerOffset] = React.useState(0);
  const [atMentionHighlightedIndex, setAtMentionHighlightedIndex] = React.useState(0);
  const [atMentionHighlightedEntry, setAtMentionHighlightedEntry] = React.useState<AtMentionEntry | null>(null);

  React.useEffect(() => {
    if (!sessionId) {
      setInput("");
    }
    setComposerError(null);
  }, [sessionId]);

  // Reset the compacting guard when the heartbeat confirms compact is done
  React.useEffect(() => {
    if (!isCompacting) {
      compactingRef.current = false;
    }
  }, [isCompacting]);

  // Esc key stops an active agent turn (same as clicking the stop button).
  // We skip this when a dialog or the command picker or @-mention popover is open —
  // those components handle Escape themselves via Radix's event propagation.
  React.useEffect(() => {
    if (!agentActive || !onExec) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showClearDialog || showEndSessionDialog || commandOpen || atMentionOpen) return;
      e.preventDefault();
      onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "abort" });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [agentActive, onExec, showClearDialog, showEndSessionDialog, commandOpen, atMentionOpen]);

  // Commands from the CLI that the web UI already handles via executeSlashCommand.
  // These are excluded from the "CLI Commands" group to avoid duplicates.
  const webHandledCommands = React.useMemo(() => new Set([
    "new", "resume", "mcp", "plugins", "skills", "agents", "model", "cycle_model",
    "effort", "cycle_effort", "compact", "name", "copy", "stop", "restart",
    "remote", "plan",
  ]), []);

  // MCP toggle handler — sends mcp_toggle_server remote exec to the runner
  const handleMcpToggle = React.useCallback<McpToggleHandler>((serverName, disabled) => {
    if (!onExec) return;
    onExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "mcp_toggle_server",
      serverName,
      disabled,
    });
  }, [onExec]);

  // Split availableCommands (from the CLI) into groups by source.
  // Everything not already handled by the web UI is shown in the hotbar.
  type CmdEntry = { name: string; description?: string; source?: string };
  const { extensionCommands, skillCommands, promptCommands } = React.useMemo<{
    extensionCommands: CmdEntry[];
    skillCommands: CmdEntry[];
    promptCommands: CmdEntry[];
  }>(() => {
    if (!availableCommands) return { extensionCommands: [], skillCommands: [], promptCommands: [] };
    const ext: CmdEntry[] = [];
    const skill: CmdEntry[] = [];
    const prompt: CmdEntry[] = [];
    for (const c of availableCommands) {
      if (webHandledCommands.has(c.name.toLowerCase())) continue;
      if (c.source === "skill") skill.push(c);
      else if (c.source === "prompt") prompt.push(c);
      else ext.push(c); // "extension" or unknown source
    }
    return { extensionCommands: ext, skillCommands: skill, promptCommands: prompt };
  }, [availableCommands, webHandledCommands]);

  const executeSlashCommand = React.useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;

    const [rawCommandInput, ...rest] = trimmed.slice(1).split(/\s+/);
    const rawCommand = rawCommandInput?.toLowerCase() ?? "";
    const args = rest.join(" ");
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    if (rawCommand === "new") {
      if (onExec) {
        onExec({ type: "exec", id, command: "new_session" });
      } else if (onSendInput) {
        // Fallback: older runners/websocket paths may not support exec.
        // Sending "/new" as a normal input at least triggers the built-in command.
        void onSendInput({ text: "/new", files: [] });
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    // /plugins and /skills use HTTP fetch, not onExec — handle before the exec guard
    if (rawCommand === "plugins") {
      if (!runnerId) {
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        onAppendSystemMessage?.("**Plugins** — Runner not connected yet. Try again in a moment.");
        return true;
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      const pluginsUrl = sessionCwd
        ? `/api/runners/${encodeURIComponent(runnerId)}/plugins?cwd=${encodeURIComponent(sessionCwd)}`
        : `/api/runners/${encodeURIComponent(runnerId)}/plugins`;
      // Capture sessionId at dispatch time; compare against mutable ref
      // to detect session switches while the fetch is in-flight.
      const dispatchSessionId = sessionId;
      fetch(pluginsUrl, { credentials: "include" })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then((data: any) => {
          if (dispatchSessionId !== sessionIdRef.current) return; // session changed, discard
          const raw: Array<{ name: string; description?: string; commands?: Array<{ name: string; description?: string }>; hookEvents?: string[]; skills?: Array<{ name: string }>; agents?: Array<{ name: string }>; rules?: Array<{ name: string }>; version?: string; hasMcp?: boolean; hasAgents?: boolean }> = Array.isArray(data?.plugins) ? data.plugins : [];
          onAppendSystemMessage?.({
            kind: "plugins",
            plugins: raw.map((p) => ({
              name: p.name,
              description: p.description,
              version: p.version,
              commands: (p.commands ?? []).map((c) => ({ name: c.name, description: c.description })),
              hookCount: p.hookEvents?.length ?? 0,
              skillCount: p.skills?.length ?? 0,
              agentCount: p.agents?.length ?? 0,
              ruleCount: p.rules?.length ?? 0,
              hasMcp: !!p.hasMcp,
              hasAgents: !!p.hasAgents,
            })),
          });
        })
        .catch((err: Error) => {
          if (dispatchSessionId !== sessionIdRef.current) return;
          onAppendSystemMessage?.(`**Plugins** — Failed to load: ${err.message}`);
        });
      return true;
    }

    if (rawCommand === "skills") {
      if (!runnerId) {
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        onAppendSystemMessage?.("**Skills** — Runner not connected yet. Try again in a moment.");
        return true;
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      // Capture sessionId at dispatch time to discard stale responses
      // when the user switches sessions while the fetch is in-flight.
      const dispatchSessionId = sessionId;
      fetch(`/api/runners/${encodeURIComponent(runnerId)}/skills`, { credentials: "include" })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then((data: any) => {
          if (dispatchSessionId !== sessionIdRef.current) return; // session changed, discard
          const skills: Array<{ name: string; description?: string }> = Array.isArray(data?.skills) ? data.skills : [];
          // Merge CLI-advertised skill commands (which include project-local skills the
          // runner sees but the REST cache may not) so the user gets the full picture.
          const merged = new Map<string, { name: string; description?: string }>();
          for (const s of skills) merged.set(s.name, s);
          for (const cmd of skillCommands) {
            const skillName = cmd.name.replace(/^skill:/, "");
            if (!merged.has(skillName)) {
              merged.set(skillName, { name: skillName, description: cmd.description });
            }
          }
          onAppendSystemMessage?.({
            kind: "skills",
            skills: Array.from(merged.values()),
          });
        })
        .catch((err: Error) => {
          if (dispatchSessionId !== sessionIdRef.current) return;
          onAppendSystemMessage?.(`**Skills** — Failed to load: ${err.message}`);
        });
      return true;
    }

    // /agents is handled via the dynamic agent picker (isAgentMode) in the
    // command popover — selecting an agent from the list triggers onSpawnAgentSession.
    // If the user types "/agents <name>" and hits Enter, we resolve it here.
    if (rawCommand === "agents") {
      if (args.trim()) {
        // User typed "/agents researcher" — find and spawn that agent
        const agentName = args.trim();
        if (onSpawnAgentSession && runnerId) {
          // Capture sessionId at dispatch time to discard stale responses
          // when the user switches sessions while the fetch is in-flight.
          const dispatchSessionId = sessionId;
          fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, { credentials: "include" })
            .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then((data: any) => {
              if (dispatchSessionId !== sessionIdRef.current) return; // session changed, discard
              const agents: Array<{ name: string; description?: string; content?: string }> = Array.isArray(data?.agents) ? data.agents : [];
              const match = agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
              if (match) {
                onSpawnAgentSession({ name: match.name, description: match.description, systemPrompt: match.content });
              } else {
                onAppendSystemMessage?.(`**Agents** — Agent "${agentName}" not found.`);
              }
            })
            .catch((err: Error) => {
              if (dispatchSessionId !== sessionIdRef.current) return;
              onAppendSystemMessage?.(`**Agents** — Failed to load: ${err.message}`);
            });
        }
      }
      // Without args, the popover handles it (isAgentMode)
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (!onExec) return false;

    if (rawCommand === "mcp") {
      const argLower = args.trim().toLowerCase();
      if (argLower.startsWith("disable ") || argLower.startsWith("enable ")) {
        const isDisable = argLower.startsWith("disable ");
        const serverName = args.trim().slice(isDisable ? 8 : 7).trim();
        if (serverName) {
          onExec({ type: "exec", id, command: "mcp_toggle_server", serverName, disabled: isDisable });
        }
      } else if (argLower === "disable" || argLower === "enable") {
        // Bare disable/enable without a server name — show a hint instead of
        // silently falling through to status.
        onAppendSystemMessage?.(`Usage: \`/mcp ${argLower} <server-name>\``);
      } else {
        const action = argLower === "reload" ? "reload" : "status";
        onExec({ type: "exec", id, command: "mcp", action });
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "resume") {
      const selected = !args ? resumeSessions?.[0] : undefined;
      if (selected) {
        onExec({ type: "exec", id, command: "resume_session", sessionPath: selected.path });
      } else {
        onExec({ type: "exec", id, command: "resume_session", query: args || undefined });
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "model" || rawCommand === "cycle_model") {
      if (onShowModelSelector) {
        onShowModelSelector();
      } else {
        onExec({ type: "exec", id, command: "cycle_model" });
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "effort" || rawCommand === "cycle_effort") {
      onExec({ type: "exec", id, command: "cycle_thinking_level" });
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "compact") {
      if (isCompacting || compactingRef.current) {
        return true; // Already compacting — ignore duplicate
      }
      const dispatched = onExec({ type: "exec", id, command: "compact", customInstructions: args || undefined });
      // Only mark as compacting if dispatch succeeded; otherwise the ref
      // would stay true and silently block all future /compact commands.
      if (dispatched !== false) {
        compactingRef.current = true;
      }
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "name") {
      onExec({ type: "exec", id, command: "set_session_name", name: args });
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "copy") {
      onExec({ type: "exec", id, command: "get_last_assistant_text" });
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "stop") {
      onExec({ type: "exec", id, command: "abort" });
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "restart") {
      onExec({ type: "exec", id, command: "restart" });
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    if (rawCommand === "plan") {
      onExec({ type: "exec", id, command: "set_plan_mode" });
      setInput("");
      setCommandOpen(false);
      setCommandQuery("");
      return true;
    }

    return false;
  }, [onExec, onSendInput, resumeSessions, runnerId, onAppendSystemMessage, skillCommands, sessionCwd, onShowModelSelector, isCompacting, sessionId, onSpawnAgentSession]);

  const handleSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      if (isCompacting) return; // Block input while compacting
      const text = message.text.trim();
      const hasAttachments = Array.isArray(message.files) && message.files.length > 0;
      if ((!text && !hasAttachments) || !sessionId) return;

      setComposerError(null);

      if (text && executeSlashCommand(text)) return;
      if (!onSendInput) return;

      // When the agent is active, attach the delivery mode
      const payload = agentActive
        ? { ...message, deliverAs: deliveryMode }
        : message;

      Promise.resolve(onSendInput(payload))
        .then((result) => {
          if (result !== false) {
            setInput("");
            setCommandOpen(false);
            setCommandQuery("");
          } else {
            setComposerError("Failed to send message.");
          }
        })
        .catch(() => {
          setComposerError("Failed to send message.");
        });
    },
    [executeSlashCommand, onSendInput, sessionId, agentActive, isCompacting, deliveryMode],
  );

  const supportedWebCommands = React.useMemo(() => {
    // Commands that we intercept/execute via exec.
    // Commands with `subCommands` keep the popover open after typing a space
    // so the user can pick from the available options.
    return [
      { name: "new", description: "Start a new conversation" },
      { name: "resume", description: "Resume the previous session" },
      { name: "mcp", description: "MCP server management", subCommands: [
        { name: "status", description: "Show MCP server status" },
        { name: "reload", description: "Reload MCP servers" },
        { name: "disable", description: "Disable an MCP server", requiresArg: true },
        { name: "enable", description: "Enable a disabled MCP server", requiresArg: true },
      ]},
      { name: "plugins", description: "Show loaded plugins" },
      { name: "skills", description: "Show available skills" },
      { name: "agents", description: "Start a new session as an agent" },
      { name: "model", description: "Select model" },
      { name: "cycle_model", description: "Select model" },
      { name: "effort", description: "Cycle reasoning effort level" },
      { name: "cycle_effort", description: "Cycle reasoning effort level" },
      { name: "compact", description: "Compact context" },
      { name: "name", description: "Set session name" },
      { name: "copy", description: "Copy last assistant message" },
      { name: "stop", description: "Abort current generation" },
      { name: "restart", description: "Restart the CLI process" },
      { name: "plan", description: "Toggle plan mode (read-only exploration)" },
    ] as Array<{ name: string; description: string; subCommands?: Array<{ name: string; description: string; requiresArg?: boolean }> }>;
  }, []);

  // Set of all known command/skill names for quick lookup (used to auto-close popover
  // once the user has typed a recognized command and started entering arguments).
  const knownCommandNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const c of supportedWebCommands) names.add(c.name.toLowerCase());
    for (const c of extensionCommands) names.add(c.name.toLowerCase());
    for (const c of skillCommands) names.add(c.name.toLowerCase());
    for (const c of promptCommands) names.add(c.name.toLowerCase());
    return names;
  }, [supportedWebCommands, extensionCommands, skillCommands, promptCommands]);

  // Commands that keep the popover open after a space (for argument/sub-command UI).
  // Derived from commands with subCommands, plus "resume" which has its own picker.
  const keepPopoverOpenNames = React.useMemo(() => {
    const names = new Set(["resume", "agents"]);
    for (const c of supportedWebCommands) {
      if (c.subCommands && c.subCommands.length > 0) names.add(c.name.toLowerCase());
    }
    return names;
  }, [supportedWebCommands]);

  // Reset highlighted index when the query or mode changes
  React.useEffect(() => {
    setCommandHighlightedIndex(0);
  }, [commandQuery]);

  const commandSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const list = supportedWebCommands;
    if (!query) return list;
    return list.filter((c) => c.name.toLowerCase().includes(query));
  }, [commandQuery, supportedWebCommands]);

  const skillSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return skillCommands;
    return skillCommands.filter(
      (c) => c.name.toLowerCase().includes(query) || (c.description?.toLowerCase().includes(query) ?? false),
    );
  }, [commandQuery, skillCommands]);

  const extensionSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return extensionCommands;
    return extensionCommands.filter(
      (c) => c.name.toLowerCase().includes(query) || (c.description?.toLowerCase().includes(query) ?? false),
    );
  }, [commandQuery, extensionCommands]);

  const promptSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return promptCommands;
    return promptCommands.filter(
      (c) => c.name.toLowerCase().includes(query) || (c.description?.toLowerCase().includes(query) ?? false),
    );
  }, [commandQuery, promptCommands]);

  // @-mention file selection: replace trigger to cursor with @{relativePath} 
  const handleAtMentionSelectFile = React.useCallback((relativePath: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
    if (!textarea) return;

    const cursorPosition = textarea.selectionStart;
    const value = input;

    // Replace from trigger offset to cursor position with @{relativePath} (trailing space)
    const newValue = value.slice(0, atMentionTriggerOffset) + "@" + relativePath + " " + value.slice(cursorPosition);
    setInput(newValue);

    // Position cursor after the inserted text
    const newCursorPosition = atMentionTriggerOffset + 1 + relativePath.length + 1; // @ + path + space
    requestAnimationFrame(() => {
      textarea.setSelectionRange(newCursorPosition, newCursorPosition);
      textarea.focus();
    });

    // Reset @-mention state
    setAtMentionOpen(false);
    setAtMentionQuery("");
    setAtMentionPath("");
    setAtMentionTriggerOffset(0);
    setAtMentionHighlightedIndex(0);
  }, [input, atMentionTriggerOffset]);

  // @-mention drill into directory
  const handleAtMentionDrillInto = React.useCallback((newPath: string) => {
    setAtMentionPath(newPath);
    setAtMentionQuery("");
    setAtMentionHighlightedIndex(0);
    // Update the input text to reflect the new path
    const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
    if (textarea) {
      const cursorPosition = textarea.selectionStart;
      const value = input;
      // Replace from trigger offset to cursor with @{newPath}
      const newValue = value.slice(0, atMentionTriggerOffset) + "@" + newPath + value.slice(cursorPosition);
      setInput(newValue);
      // Position cursor after the path
      const newCursorPosition = atMentionTriggerOffset + 1 + newPath.length;
      requestAnimationFrame(() => {
        textarea.setSelectionRange(newCursorPosition, newCursorPosition);
        textarea.focus();
      });
    }
  }, [input, atMentionTriggerOffset]);

  // @-mention back navigation: pop last path segment
  const handleAtMentionBack = React.useCallback(() => {
    if (!atMentionPath) return;
    // Pop the last path segment: path.split('/').slice(0, -1).join('/')
    const segments = atMentionPath.split("/").filter(Boolean);
    const newPath = segments.slice(0, -1).join("/");
    const newPathWithSlash = newPath ? newPath + "/" : "";
    handleAtMentionDrillInto(newPathWithSlash);
  }, [atMentionPath, handleAtMentionDrillInto]);

  // @-mention close popover
  const handleAtMentionClose = React.useCallback(() => {
    setAtMentionOpen(false);
    setAtMentionQuery("");
    setAtMentionPath("");
    setAtMentionTriggerOffset(0);
    setAtMentionHighlightedIndex(0);
    setAtMentionHighlightedEntry(null);
  }, []);

  const trimmedInput = input.trimStart();
  const isResumeMode = /^\/resume(?:\s|$)/i.test(trimmedInput);
  const isAgentMode = /^\/agents(?:\s|$)/i.test(trimmedInput);
  const resumeQuery = isResumeMode ? trimmedInput.replace(/^\/resume\s*/i, "").trim().toLowerCase() : "";
  const resumeCandidates = React.useMemo(() => {
    const list = resumeSessions ?? [];
    if (!resumeQuery) return list;
    return list.filter((session) => {
      const name = (session.name ?? "").toLowerCase();
      const id = session.id.toLowerCase();
      const path = session.path.toLowerCase();
      const preview = (session.firstMessage ?? "").toLowerCase();
      return (
        name.includes(resumeQuery) ||
        id.includes(resumeQuery) ||
        path.includes(resumeQuery) ||
        preview.includes(resumeQuery)
      );
    });
  }, [resumeSessions, resumeQuery]);

  // ── Agent mode state ────────────────────────────────────────────────────
  const agentQuery = isAgentMode ? trimmedInput.replace(/^\/agents\s*/i, "").trim().toLowerCase() : "";
  const [agentsList, setAgentsList] = React.useState<Array<{ name: string; description?: string; content?: string }>>([]);
  const [agentsLoading, setAgentsLoading] = React.useState(false);
  const agentsRequestedRef = React.useRef<string | null>(null);

  const agentCandidates = React.useMemo(() => {
    if (!agentQuery) return agentsList;
    return agentsList.filter((a) => {
      const name = a.name.toLowerCase();
      const desc = (a.description ?? "").toLowerCase();
      return name.includes(agentQuery) || desc.includes(agentQuery);
    });
  }, [agentsList, agentQuery]);

  // Fetch agents when agent mode activates
  React.useEffect(() => {
    if (!sessionId || !commandOpen || !isAgentMode || !runnerId) return;
    const requestKey = `${sessionId}-${runnerId}`;
    if (agentsRequestedRef.current === requestKey) return;
    agentsRequestedRef.current = requestKey;
    let stale = false;
    setAgentsLoading(true);
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, { credentials: "include" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: any) => {
        if (stale) return; // session/runner changed while fetch was in-flight
        const agents: Array<{ name: string; description?: string; content?: string }> = Array.isArray(data?.agents) ? data.agents : [];
        setAgentsList(agents);
      })
      .catch(() => {
        if (stale) return;
        setAgentsList([]);
      })
      .finally(() => { if (!stale) setAgentsLoading(false); });
    return () => { stale = true; };
  }, [sessionId, commandOpen, isAgentMode, runnerId]);

  // Reset agent request ref when agent mode closes
  React.useEffect(() => {
    if (!commandOpen || !isAgentMode) {
      agentsRequestedRef.current = null;
    }
  }, [commandOpen, isAgentMode]);

  // Sub-command mode: detect when the user has typed a command that has sub-commands
  // e.g. "/mcp " or "/mcp rel" → show sub-command options
  const subCommandMode = React.useMemo<{
    active: boolean;
    parentCommand: string;
    subCommands: Array<{ name: string; description: string; requiresArg?: boolean }>;
    query: string;
    filtered: Array<{ name: string; description: string; requiresArg?: boolean }>;
  }>(() => {
    if (isResumeMode || isAgentMode) return { active: false, parentCommand: "", subCommands: [], query: "", filtered: [] };
    const match = trimmedInput.match(/^\/(\S+)(?:\s(.*))?$/i);
    if (!match) return { active: false, parentCommand: "", subCommands: [], query: "", filtered: [] };
    const cmdName = match[1]!.toLowerCase();
    const argText = (match[2] ?? "").trim().toLowerCase();
    const cmd = supportedWebCommands.find(c => c.name.toLowerCase() === cmdName && c.subCommands && c.subCommands.length > 0);
    if (!cmd?.subCommands) return { active: false, parentCommand: "", subCommands: [], query: "", filtered: [] };
    const filtered = argText
      ? cmd.subCommands.filter(sc => sc.name.toLowerCase().includes(argText))
      : cmd.subCommands;
    return { active: true, parentCommand: cmd.name, subCommands: cmd.subCommands, query: argText, filtered };
  }, [trimmedInput, isResumeMode, isAgentMode, supportedWebCommands]);

  // Controlled value for cmdk Command (drives data-selected highlighting)
  const commandHighlightedValue = React.useMemo(() => {
    if (!commandOpen) return "";
    if (isResumeMode) {
      return resumeCandidates[commandHighlightedIndex]?.path ?? "";
    }
    if (isAgentMode) {
      return agentCandidates[commandHighlightedIndex]?.name ?? "";
    }
    if (subCommandMode.active) {
      return subCommandMode.filtered[commandHighlightedIndex]?.name ?? "";
    }
    const combined = [...commandSuggestions, ...extensionSuggestions, ...promptSuggestions, ...skillSuggestions];
    return combined[commandHighlightedIndex]?.name ?? "";
  }, [commandOpen, isResumeMode, isAgentMode, subCommandMode, resumeCandidates, agentCandidates, commandSuggestions, extensionSuggestions, promptSuggestions, skillSuggestions, commandHighlightedIndex]);

  const resumeRequestedRef = React.useRef<string | null>(null);
  const compactingRef = React.useRef(false);
  // Mutable ref for current sessionId — used by async slash-command callbacks
  // to detect session switches after dispatch.
  const sessionIdRef = React.useRef(sessionId);
  React.useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId || !commandOpen || !isResumeMode || !onRequestResumeSessions) return;
    const requestKey = sessionId;
    if (resumeRequestedRef.current === requestKey) return;
    resumeRequestedRef.current = requestKey;
    onRequestResumeSessions();
  }, [sessionId, commandOpen, isResumeMode, onRequestResumeSessions]);

  React.useEffect(() => {
    if (!sessionId) {
      resumeRequestedRef.current = null;
    }
  }, [sessionId]);

  React.useEffect(() => {
    if (!commandOpen || !isResumeMode) {
      resumeRequestedRef.current = null;
    }
  }, [commandOpen, isResumeMode]);

  // Session actions context — allows deeply nested tool cards (e.g. bash) to
  // trigger session-level actions without prop drilling.
  const sessionActions = React.useMemo<SessionActions | null>(() => {
    if (!onExec) return null;
    return {
      abort: () => {
        onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "abort" });
      },
    };
  }, [onExec]);

  const groupedMessages = React.useMemo(
    () => groupSubAgentConversations(groupToolExecutionMessages(messages)),
    [messages],
  );

  // Stable sort: messages with a timestamp come first (ordered by timestamp);
  // messages with no timestamp are placed at the absolute end in their original
  // relative order. This prevents timestampless messages (e.g. synthesised tool
  // cards, streaming partials) from appearing in the middle of a conversation.
  const sortedMessages = React.useMemo(() => {
    const withTs: RelayMessage[] = [];
    const withoutTs: RelayMessage[] = [];
    for (const msg of groupedMessages) {
      if (msg.timestamp != null) {
        withTs.push(msg);
      } else {
        withoutTs.push(msg);
      }
    }
    withTs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return [...withTs, ...withoutTs];
  }, [groupedMessages]);

  const visibleMessages = React.useMemo(
    () => sortedMessages.filter((message) => {
      if (message.role === "subAgentConversation") return (message.subAgentTurns?.length ?? 0) > 0;
      // Compaction/branch summary messages are always visible when they have a summary
      if ((message.role === "compactionSummary" || message.role === "branchSummary") && message.summary) return true;
      if (hasVisibleContent(message.content)) return true;
      if (message.stopReason === "error" && message.errorMessage) return true;
      return (message.role === "toolResult" || message.role === "tool") && message.toolInput !== undefined;
    }),
    [sortedMessages],
  );

  const PAGE_SIZE = 50;

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = React.useState(true);
  const isNearBottomRef = React.useRef(true);
  const [renderedCount, setRenderedCount] = React.useState(PAGE_SIZE);

  // Reset window when session or message list changes significantly.
  React.useEffect(() => {
    setRenderedCount(PAGE_SIZE);
  }, [sessionId]);

  const renderedMessages = React.useMemo(
    () => visibleMessages.slice(-renderedCount),
    [visibleMessages, renderedCount],
  );
  const hasMore = visibleMessages.length > renderedCount;

  const updateNearBottomState = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 200;
    isNearBottomRef.current = nearBottom;
    setIsNearBottom(nearBottom);
  }, []);

  const scrollToBottom = React.useCallback((behavior: "auto" | "smooth" = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // ResizeObserver: when the scroll content grows in height (e.g. during thinking/
  // streaming where message count stays the same), keep pinned to the bottom.
  // We calculate distance directly instead of relying on isNearBottomRef, which
  // can be flipped to false by a scroll event that fires between the content
  // resize and this callback (race condition).
  React.useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return;
    const observer = new ResizeObserver(() => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (distance < 200 || isNearBottomRef.current) {
        scrollToBottom("auto");
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // When the sentinel at the top enters the viewport, load the previous page
  // while preserving the scroll position so the view doesn't jump.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollRef.current;
    if (!sentinel || !scroller || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        const prevScrollHeight = scroller.scrollHeight;
        setRenderedCount((c) => c + PAGE_SIZE);
        // After React re-renders with more items, restore scroll position so
        // the user stays at the same message they were looking at.
        requestAnimationFrame(() => {
          scroller.scrollTop += scroller.scrollHeight - prevScrollHeight;
        });
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  // On session change, jump to bottom immediately.
  React.useEffect(() => {
    if (!sessionId) return;
    requestAnimationFrame(() => {
      scrollToBottom("auto");
      updateNearBottomState();
    });
  }, [sessionId, scrollToBottom, updateNearBottomState]);

  // When new messages arrive and we're near the bottom, keep pinned.
  React.useEffect(() => {
    if (!isNearBottom) return;
    requestAnimationFrame(() => {
      scrollToBottom("auto");
      updateNearBottomState();
    });
  }, [visibleMessages, isNearBottom, scrollToBottom, updateNearBottomState]);

  return (
    <SessionActionsProvider value={sessionActions}>
    <McpToggleContext.Provider value={onExec ? handleMcpToggle : null}>
    <div className="flex flex-col flex-1 min-h-0">
      {/* Session info bar */}
      {sessionId && (
        <div className="border-b border-border px-3 py-2 flex items-center gap-2 min-w-0">
          {/* Status dot */}
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full flex-shrink-0 transition-colors",
              isCompacting
                ? "bg-amber-400 shadow-[0_0_6px_#fbbf2480] animate-pulse"
                : agentActive
                  ? "bg-green-400 shadow-[0_0_6px_#4ade8080] animate-pulse"
                  : lastHeartbeatAt
                    ? "bg-slate-400"
                    : "bg-slate-600",
            )}
            title={
              isCompacting ? "Compacting context…"
              : agentActive ? "Agent active"
              : lastHeartbeatAt ? "Agent idle"
              : "No heartbeat yet"
            }
          />
          {/* Transient status (compacting, etc.) */}
          {viewerStatus && viewerStatus !== "Connected" && viewerStatus !== "Idle" && viewerStatus !== "Connecting…" && (
            <span className="text-[0.65rem] text-muted-foreground font-medium truncate max-w-32 animate-in fade-in duration-300">
              {viewerStatus}
            </span>
          )}

          {/* Session name + model */}
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-sm font-medium truncate leading-none">
              {sessionName || `Session ${sessionId.slice(0, 8)}…`}
            </span>
            {activeModel?.provider && (
              <span
                className="hidden sm:inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[0.65rem] text-muted-foreground flex-shrink-0"
                title={`${activeModel.provider} · ${activeModel.name ?? activeModel.id}`}
              >
                <ProviderIcon provider={activeModel.provider} className="size-3" />
                <span className="max-w-24 truncate">{activeModel.provider}</span>
              </span>
            )}
          </div>

          {/* Right: badges + end session */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <HeartbeatStaleBadge lastHeartbeatAt={lastHeartbeatAt} />
            {(activeModel?.reasoning || effortLevel != null) && (
              <button
                className="rounded-full border border-border bg-muted px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide hover:bg-muted/80 transition-colors cursor-pointer"
                onClick={() => {
                  if (onExec) {
                    onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "cycle_thinking_level" });
                  }
                }}
                title="Click to cycle effort level"
                aria-label={`Cycle reasoning effort level (current: ${effortLevel && effortLevel !== "off" ? effortLevel : "off"})`}
                type="button"
              >
                {effortLevel && effortLevel !== "off" ? effortLevel : "off"}
              </button>
            )}
            {planModeEnabled && (
              <button
                className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[0.65rem] font-medium text-yellow-600 dark:text-yellow-400 uppercase tracking-wide hover:bg-yellow-500/20 transition-colors cursor-pointer"
                onClick={() => {
                  if (onExec) {
                    onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "set_plan_mode", enabled: false } as any);
                  }
                }}
                title="Plan mode active — click to turn off"
                aria-label="Turn off plan mode"
                type="button"
              >
                ⏸ plan
              </button>
            )}
            {tokenUsage && (tokenUsage.input > 0 || tokenUsage.output > 0) && (
              <span
                className="text-[0.7rem] text-muted-foreground tabular-nums hidden xs:inline"
                title={`Input: ${tokenUsage.input.toLocaleString()} tokens\nOutput: ${tokenUsage.output.toLocaleString()} tokens${tokenUsage.cacheRead ? `\nCache read: ${tokenUsage.cacheRead.toLocaleString()}` : ""}${tokenUsage.cacheWrite ? `\nCache write: ${tokenUsage.cacheWrite.toLocaleString()}` : ""}${tokenUsage.cost ? `\nCost: $${tokenUsage.cost.toFixed(4)}` : ""}`}
              >
                ↑{formatTokenCount(tokenUsage.input)} ↓{formatTokenCount(tokenUsage.output)}
                <span className="hidden sm:inline">
                  {tokenUsage.cost > 0 && ` · $${tokenUsage.cost.toFixed(3)}`}
                </span>
              </span>
            )}
            {showTerminalButton && onToggleTerminal && (
              <Button
                className="h-7 w-7 sm:h-7 sm:w-auto sm:px-2.5 sm:text-[0.7rem]"
                onClick={onToggleTerminal}
                size="icon"
                type="button"
                variant="outline"
                title="Toggle terminal"
                aria-label="Toggle terminal"
              >
                <TerminalIcon className="size-3.5" />
                <span className="hidden sm:inline ml-1">Terminal</span>
              </Button>
            )}
            {showFileExplorerButton && onToggleFileExplorer && (
              <Button
                className="h-7 w-7 sm:h-7 sm:w-auto sm:px-2.5 sm:text-[0.7rem]"
                onClick={onToggleFileExplorer}
                size="icon"
                type="button"
                variant="outline"
                title="Toggle file explorer"
                aria-label="Toggle file explorer"
              >
                <FolderTree className="size-3.5" />
                <span className="hidden sm:inline ml-1">Files</span>
              </Button>
            )}
            <ConversationDownload
              messages={sortedMessages.map((m) => ({
                role: toMessageRole(m.role),
                content:
                  typeof m.content === "string"
                    ? m.content
                    : JSON.stringify(m.content, null, 2),
              }))}
              filename={`session-${sessionId || "export"}.md`}
              className="static top-auto right-auto h-7 w-7 sm:h-7 sm:w-auto sm:px-2.5 sm:text-[0.7rem] border-border bg-background hover:bg-accent hover:text-accent-foreground rounded-md"
              variant="outline"
              size="icon"
              title="Download conversation markdown"
              aria-label="Download conversation"
            >
              <DownloadIcon className="size-3.5" />
              <span className="hidden sm:inline ml-1">Save</span>
            </ConversationDownload>
            <Button
              className="h-7 w-7 sm:h-7 sm:w-auto sm:px-2.5 sm:text-[0.7rem]"
              disabled={!onExec}
              onClick={() => {
                if (!onExec || !sessionId) return;
                if (window.innerWidth < 640) {
                  setShowEndSessionDialog(true);
                } else {
                  onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "end_session" });
                }
              }}
              size="icon"
              type="button"
              variant="destructive"
              title="End Session"
              aria-label="End session"
            >
              <OctagonX className="size-3.5" />
              <span className="hidden sm:inline ml-1">End</span>
            </Button>
            <Button
              className="h-7 w-7 sm:h-7 sm:w-auto sm:px-2.5 sm:text-[0.7rem]"
              disabled={!onExec}
              onClick={() => {
                if (!onExec) return;
                if (window.innerWidth < 640) {
                  setShowClearDialog(true);
                } else {
                  onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "new_session" });
                }
              }}
              size="icon"
              type="button"
              variant="outline"
              title="New conversation (/new)"
              aria-label="Clear conversation"
            >
              <Plus className="size-3.5" />
              <span className="hidden sm:inline ml-1">Clear</span>
            </Button>
          </div>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        {!sessionId ? (
          <ConversationEmptyState
            icon={<MessageSquare className="size-8 opacity-40" />}
            title="No session selected"
            description="Open the sidebar and pick a session to get started."
          />
        ) : visibleMessages.length === 0 ? (
          viewerStatus === "Connecting…" ? (
            <SessionSkeleton />
          ) : (
            <ConversationEmptyState
              icon={
                <span className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-muted/60 border border-border/60">
                  <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-400 animate-pulse" />
                </span>
              }
              title="Waiting for session events"
              description="Messages will appear here in real time."
            />
          )
        ) : (
          <>
            <div
              ref={scrollRef}
              className="h-full overflow-y-auto overflow-x-hidden"
              onScroll={updateNearBottomState}
            >
              <div ref={contentRef} className="w-full py-2 flex flex-col min-h-full justify-end">
                {/* Sentinel: scrolling up to this triggers loading older messages */}
                <div ref={sentinelRef} className="h-px" />
                {hasMore && (
                  <div className="py-2 text-center text-xs text-muted-foreground">
                    Scroll up for older messages
                  </div>
                )}
                {renderedMessages.map((message, index) => (
                  <SessionMessageItem
                    key={message.key}
                    message={message}
                    activeToolCalls={activeToolCalls}
                    agentActive={agentActive}
                    isLast={index === renderedMessages.length - 1}
                  />
                ))}
              </div>
            </div>

            {!isNearBottom && (
              <Button
                className="absolute bottom-4 left-[50%] -translate-x-1/2 rounded-full"
                onClick={() => scrollToBottom("smooth")}
                size="icon"
                type="button"
                variant="outline"
                aria-label="Scroll to bottom"
              >
                <ArrowDownIcon className="size-4" />
              </Button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border px-3 py-2 pp-safe-bottom">
        {/* Message queue display */}
        {sessionId && messageQueue && messageQueue.length > 0 && (
          <div className="mb-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide">
                Queued messages ({messageQueue.length})
              </span>
              {onClearMessageQueue && (
                <button
                  type="button"
                  onClick={onClearMessageQueue}
                  className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground hover:text-destructive transition-colors"
                  title="Clear all queued messages"
                >
                  <Trash2 className="size-3" />
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-col gap-1">
              {messageQueue.map((qm) => (
                <div key={qm.id} className="flex items-start gap-2 text-xs group">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide flex-shrink-0 mt-0.5",
                      qm.deliverAs === "steer"
                        ? "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                        : "bg-blue-500/15 text-blue-500 border border-blue-500/30",
                    )}
                  >
                    {qm.deliverAs === "steer" ? (
                      <><Zap className="size-2.5" /> Steer</>
                    ) : (
                      <><Clock className="size-2.5" /> Follow-up</>
                    )}
                  </span>
                  <span className="truncate flex-1 text-foreground/80 leading-relaxed">{qm.text}</span>
                  {onRemoveQueuedMessage && (
                    <button
                      type="button"
                      onClick={() => onRemoveQueuedMessage(qm.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all flex-shrink-0 mt-0.5"
                      title="Remove queued message"
                      aria-label="Remove queued message"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {retryState && agentActive && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
            <Clock className="size-3.5 shrink-0 animate-spin" style={{ animationDuration: "3s" }} />
            <span>
              <span className="font-semibold">Auto-retrying:</span>{" "}
              {retryState.errorMessage}
            </span>
          </div>
        )}

        {/* Plugin trust prompt (shown above the input area) */}
        {pluginTrustPrompt && onPluginTrustResponse && (
          <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 shadow-sm">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="flex-1 min-w-0 space-y-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Untrusted Project Plugins</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pluginTrustPrompt.pluginNames.length === 1
                      ? "A project-local Claude Code plugin wants to load. It can execute shell commands via hooks."
                      : `${pluginTrustPrompt.pluginNames.length} project-local Claude Code plugins want to load. They can execute shell commands via hooks.`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {pluginTrustPrompt.pluginSummaries.map((summary, i) => (
                    <span
                      key={pluginTrustPrompt.pluginNames[i]}
                      className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-mono text-amber-700 dark:text-amber-400 ring-1 ring-amber-500/20"
                    >
                      {summary}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className="inline-flex items-center rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-amber-600 transition-colors"
                    onClick={() => onPluginTrustResponse(true)}
                  >
                    Trust &amp; Load
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80 transition-colors"
                    onClick={() => onPluginTrustResponse(false)}
                  >
                    Skip
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Multiple-choice questions (shown above the input area) */}
        {pendingQuestion && sessionId && pendingQuestion.questions.length > 0 && (
          <MultipleChoiceQuestions
            questions={pendingQuestion.questions}
            promptKey={pendingQuestion.toolCallId}
            className="mb-2"
            onSubmit={(answers) => {
              if (!onSendInput) return Promise.resolve(false);
              setComposerError(null);
              const text = formatAnswersForAgent(answers);
              return Promise.resolve(onSendInput(text))
                .then((result) => {
                  if (result !== false) {
                    setComposerError(null);
                    setInput("");
                    // Dismiss the push notification — user answered in-app
                    if (sessionId) void dismissNotificationsForSession(sessionId);
                    return true;
                  }
                  setComposerError("Failed to send answer.");
                  return false;
                })
                .catch(() => {
                  setComposerError("Failed to send answer.");
                  return false;
                });
            }}
          />
        )}

        {/* Plan mode review panel (shown above the input area) */}
        {pendingPlan && sessionId && (
          <PlanModePanel
            plan={pendingPlan}
            promptKey={pendingPlan.toolCallId}
            className="mb-2"
            onSubmit={(answer: PlanModeAnswer) => {
              if (!onSendInput) return Promise.resolve(false);
              setComposerError(null);
              const payload = JSON.stringify({
                action: answer.action,
                ...(answer.editSuggestion ? { editSuggestion: answer.editSuggestion } : {}),
              });
              return Promise.resolve(onSendInput(payload))
                .then((result) => {
                  if (result !== false) {
                    setComposerError(null);
                    setInput("");
                    if (sessionId) void dismissNotificationsForSession(sessionId);
                    return true;
                  }
                  setComposerError("Failed to send plan response.");
                  return false;
                })
                .catch(() => {
                  setComposerError("Failed to send plan response.");
                  return false;
                });
            }}
          />
        )}

        {sessionId && commandOpen && (
          <div className="mb-2 rounded-md border border-border bg-popover text-popover-foreground shadow-sm">
            <Command
              shouldFilter={false}
              className="w-full"
              value={commandHighlightedValue}
              onValueChange={(v) => {
                // Sync highlighted index when cmdk changes value (e.g. mouse hover)
                if (isResumeMode) {
                  const idx = resumeCandidates.findIndex(s => s.path.toLowerCase() === v.toLowerCase());
                  if (idx !== -1) setCommandHighlightedIndex(idx);
                } else if (isAgentMode) {
                  const idx = agentCandidates.findIndex(a => a.name.toLowerCase() === v.toLowerCase());
                  if (idx !== -1) setCommandHighlightedIndex(idx);
                } else if (subCommandMode.active) {
                  const idx = subCommandMode.filtered.findIndex(sc => sc.name.toLowerCase() === v.toLowerCase());
                  if (idx !== -1) setCommandHighlightedIndex(idx);
                } else {
                  const combined = [...commandSuggestions, ...extensionSuggestions, ...promptSuggestions, ...skillSuggestions];
                  const idx = combined.findIndex(c => c.name.toLowerCase() === v.toLowerCase());
                  if (idx !== -1) setCommandHighlightedIndex(idx);
                }
              }}
            >
              {/* Close button header */}
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
                <span className="text-xs text-muted-foreground font-medium">
                  {isResumeMode ? "Resume session" : isAgentMode ? "Start as agent" : subCommandMode.active ? `/${subCommandMode.parentCommand}` : "Commands"}
                </span>
                <button
                  type="button"
                  onClick={() => { setCommandOpen(false); setCommandQuery(""); }}
                  className="inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  aria-label="Close command menu"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <CommandList className="max-h-56">
                {isResumeMode ? (
                  <>
                    <CommandEmpty>{resumeSessionsLoading ? "Loading sessions…" : "No sessions found"}</CommandEmpty>
                    <CommandGroup heading="Resume session">
                      {resumeCandidates.map((session) => (
                        <CommandItem
                          key={session.path}
                          value={session.path}
                          onSelect={() => {
                            if (onExec) {
                              onExec({
                                type: "exec",
                                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                                command: "resume_session",
                                sessionPath: session.path,
                              });
                            }
                            setInput("");
                            setCommandQuery("");
                            setCommandOpen(false);
                          }}
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono text-sm truncate">{session.name || `Session ${session.id.slice(0, 8)}…`}</span>
                              <span className="text-[11px] text-muted-foreground shrink-0">{new Date(session.modified).toLocaleDateString()}</span>
                            </div>
                            <span
                              className="text-[11px] text-muted-foreground truncate"
                              title={session.path}
                            >
                              {formatPathTail(session.path, 2)}
                            </span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                ) : isAgentMode ? (
                  <>
                    <CommandEmpty>{agentsLoading ? "Loading agents…" : "No agents found"}</CommandEmpty>
                    <CommandGroup heading="Start new session as agent">
                      {agentCandidates.map((agent) => (
                        <CommandItem
                          key={agent.name}
                          value={agent.name}
                          onSelect={() => {
                            if (onSpawnAgentSession) {
                              onSpawnAgentSession({
                                name: agent.name,
                                description: agent.description,
                                systemPrompt: agent.content,
                              });
                            }
                            setInput("");
                            setCommandQuery("");
                            setCommandOpen(false);
                          }}
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <Bot className="size-3.5 shrink-0 text-primary/60" />
                              <span className="font-mono text-sm truncate">{agent.name}</span>
                            </div>
                            {agent.description && (
                              <span className="text-[11px] text-muted-foreground truncate">
                                {agent.description}
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                ) : subCommandMode.active ? (
                  <>
                    <CommandEmpty>No matching options</CommandEmpty>
                    <CommandGroup heading={`/${subCommandMode.parentCommand} options`}>
                      {subCommandMode.filtered.map((sc) => (
                        <CommandItem
                          key={sc.name}
                          value={sc.name}
                          onSelect={() => {
                            if (sc.requiresArg) {
                              // Sub-command needs an argument (e.g. server name) — fill
                              // the input instead of executing so the user can type it.
                              setInput(`/${subCommandMode.parentCommand} ${sc.name} `);
                              setCommandQuery("");
                              setCommandOpen(false);
                              setCommandHighlightedIndex(0);
                              requestAnimationFrame(() => {
                                const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                                if (textarea) {
                                  const len = textarea.value.length;
                                  textarea.setSelectionRange(len, len);
                                  textarea.focus();
                                }
                              });
                              return;
                            }
                            executeSlashCommand(`/${subCommandMode.parentCommand} ${sc.name}`);
                          }}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="font-mono text-sm">/{subCommandMode.parentCommand} {sc.name}</span>
                            {sc.description && <span className="text-xs text-muted-foreground">{sc.description}</span>}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                ) : (
                  <>
                    <CommandEmpty>No commands or skills found</CommandEmpty>
                    {commandSuggestions.length > 0 && (
                      <CommandGroup heading="Commands">
                        {commandSuggestions.map((cmd) => (
                          <CommandItem
                            key={cmd.name}
                            value={cmd.name}
                            onSelect={() => {
                              if (cmd.name === "new") {
                                executeSlashCommand("/new");
                                return;
                              }
                              setInput(`/${cmd.name} `);
                              setCommandQuery("");
                              setCommandOpen(keepPopoverOpenNames.has(cmd.name.toLowerCase()));
                              setCommandHighlightedIndex(0);
                            }}
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <span className="font-mono text-sm">/{cmd.name}</span>
                              {cmd.description && <span className="text-xs text-muted-foreground">{cmd.description}</span>}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    {extensionSuggestions.length > 0 && (
                      <CommandGroup heading="Plugin Commands">
                        {extensionSuggestions.map((cmd) => (
                          <CommandItem
                            key={cmd.name}
                            value={cmd.name}
                            onSelect={() => {
                              setInput(`/${cmd.name} `);
                              setCommandQuery("");
                              setCommandOpen(false);
                              requestAnimationFrame(() => {
                                document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]")?.focus();
                              });
                            }}
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Puzzle className="size-3.5 shrink-0 text-primary/60" />
                                <span className="font-mono text-sm truncate">/{cmd.name}</span>
                              </div>
                              {cmd.description && (
                                <span className="text-xs text-muted-foreground truncate max-w-[50%]">{cmd.description}</span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    {promptSuggestions.length > 0 && (
                      <CommandGroup heading="Prompt Templates">
                        {promptSuggestions.map((cmd) => (
                          <CommandItem
                            key={cmd.name}
                            value={cmd.name}
                            onSelect={() => {
                              setInput(`/${cmd.name} `);
                              setCommandQuery("");
                              setCommandOpen(false);
                              requestAnimationFrame(() => {
                                document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]")?.focus();
                              });
                            }}
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <span className="font-mono text-sm truncate">/{cmd.name}</span>
                              {cmd.description && (
                                <span className="text-xs text-muted-foreground truncate max-w-[50%]">{cmd.description}</span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    {skillSuggestions.length > 0 && (
                      <CommandGroup heading="Skills">
                        {skillSuggestions.map((skill) => (
                          <CommandItem
                            key={skill.name}
                            value={skill.name}
                            onSelect={() => {
                              setInput(`/${skill.name} `);
                              setCommandQuery("");
                              setCommandOpen(false);
                              requestAnimationFrame(() => {
                                document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]")?.focus();
                              });
                            }}
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <BookOpen className="size-3.5 shrink-0 text-primary/60" />
                                <span className="font-mono text-sm truncate">/{skill.name}</span>
                              </div>
                              {skill.description && (
                                <span className="text-xs text-muted-foreground truncate max-w-[50%]">{skill.description}</span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </>
                )}
              </CommandList>
            </Command>
          </div>
        )}

        {/* @-mention file autocomplete popover */}
        {sessionId && runnerId && atMentionOpen && (
          <div className="mb-2">
            <AtMentionPopover
              open={atMentionOpen}
              runnerId={runnerId}
              path={atMentionPath}
              query={atMentionQuery}
              onSelectFile={handleAtMentionSelectFile}
              onDrillInto={handleAtMentionDrillInto}
              onClose={handleAtMentionClose}
              onBack={handleAtMentionBack}
              sessionCwd={sessionCwd}
              highlightedIndex={atMentionHighlightedIndex}
              onHighlightedIndexChange={setAtMentionHighlightedIndex}
              onHighlightedEntryChange={setAtMentionHighlightedEntry}
            />
          </div>
        )}

        {isCompacting && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span>Compacting conversation history — input is disabled until complete</span>
          </div>
        )}

        {composerError && (
          <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            {composerError}
          </div>
        )}

        <PromptInput
          onSubmit={handleSubmit}
          maxFiles={8}
          maxFileSize={20 * 1024 * 1024}
          disabled={!sessionId || isCompacting}
          onError={(err) => {
            setComposerError(err.message);
          }}
          className={(pendingQuestion && pendingQuestion.questions.length > 0) || pendingPlan ? "hidden" : undefined}
        >
          <ComposerAttachments />
          <PromptInputBody>
            <div className="flex w-full items-end">
              <PromptInputTextarea
                data-pp-prompt=""
                value={input}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setComposerError(null);
                  setInput(next);

                  // Slash command detection
                  const trimmed = next.trimStart();
                  if (trimmed.startsWith("/")) {
                    const { open, query } = resolveCommandPopoverState(trimmed.slice(1), knownCommandNames, keepPopoverOpenNames);
                    setCommandOpen(open);
                    setCommandQuery(query);
                    // Close @-mention popover when slash command opens (mutual exclusivity)
                    if (atMentionOpen) {
                      setAtMentionOpen(false);
                      setAtMentionQuery("");
                      setAtMentionPath("");
                      setAtMentionTriggerOffset(0);
                    }
                    return;
                  }

                  setCommandOpen(false);
                  setCommandQuery("");

                  // @-mention detection (only when runner is connected)
                  if (!runnerId) {
                    if (atMentionOpen) {
                      setAtMentionOpen(false);
                      setAtMentionQuery("");
                      setAtMentionPath("");
                      setAtMentionTriggerOffset(0);
                    }
                    return;
                  }

                  // Use cursor position (not end of string) to scope the search.
                  // After a completed @mention like "@file.ts |", the cursor is past
                  // the space, so the @ is no longer "active" from the cursor's perspective.
                  const cursorPos = event.currentTarget.selectionStart ?? next.length;

                  // Find the last @ before the cursor that is at a word boundary
                  // Word boundary: preceded by space, newline, or start of string
                  let lastAtIndex = -1;
                  for (let i = cursorPos - 1; i >= 0; i--) {
                    if (next[i] === "@") {
                      // Check if at word boundary
                      if (i === 0 || next[i - 1] === " " || next[i - 1] === "\n" || next[i - 1] === "\t") {
                        lastAtIndex = i;
                        break;
                      }
                    }
                  }

                  if (lastAtIndex === -1) {
                    // No valid @ trigger found before cursor
                    if (atMentionOpen) {
                      setAtMentionOpen(false);
                      setAtMentionQuery("");
                      setAtMentionPath("");
                      setAtMentionTriggerOffset(0);
                    }
                    return;
                  }

                  // Extract the text between @ and the cursor (the active query)
                  const query = next.slice(lastAtIndex + 1, cursorPos);

                  // If the query contains a space that is NOT immediately after a "/",
                  // the mention is complete (e.g. "@file.ts " or "@src/file.ts more text").
                  // A trailing "/" (directory drill) should keep the popover open.
                  const spaceInQuery = query.search(/\s/);
                  if (spaceInQuery !== -1) {
                    // Space found — mention is finished, close the popover
                    if (atMentionOpen) {
                      setAtMentionOpen(false);
                      setAtMentionQuery("");
                      setAtMentionPath("");
                      setAtMentionTriggerOffset(0);
                    }
                    return;
                  }
                  
                  // Open popover and update state
                  setAtMentionOpen(true);
                  setAtMentionTriggerOffset(lastAtIndex);
                  setAtMentionQuery(query);

                  // Extract path component for directory traversal
                  // e.g., "src/components/" -> path is "src/components/", query is "src/components/"
                  // The useAtMentionFiles hook will handle extracting the directory portion
                  const lastSlash = query.lastIndexOf("/");
                  if (lastSlash !== -1) {
                    setAtMentionPath(query.slice(0, lastSlash + 1));
                  } else {
                    setAtMentionPath("");
                  }
                }}
                onKeyDown={(event) => {
                  if (!sessionId) return;

                  // Alt+Enter: toggle delivery mode (matches CLI behavior)
                  if (event.key === "Enter" && event.altKey && agentActive) {
                    event.preventDefault();
                    setDeliveryMode((m) => m === "steer" ? "followUp" : "steer");
                    return;
                  }

                  // Close @-mention popover on Escape (prevent propagation to abort shortcut)
                  if (atMentionOpen && event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setAtMentionOpen(false);
                    setAtMentionQuery("");
                    setAtMentionPath("");
                    setAtMentionTriggerOffset(0);
                    setAtMentionHighlightedIndex(0);
                    setAtMentionHighlightedEntry(null);
                    return;
                  }

                  // Tab drills into highlighted folder when @-mention is open
                  if (atMentionOpen && event.key === "Tab" && atMentionHighlightedEntry?.isDirectory) {
                    event.preventDefault();
                    event.stopPropagation();
                    const newPath = atMentionPath ? `${atMentionPath}${atMentionHighlightedEntry.name}/` : `${atMentionHighlightedEntry.name}/`;
                    handleAtMentionDrillInto(newPath);
                    return;
                  }

                  // Enter selects highlighted file when @-mention is open
                  if (atMentionOpen && event.key === "Enter" && !event.shiftKey && atMentionHighlightedEntry) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (atMentionHighlightedEntry.isDirectory) {
                      const newPath = atMentionPath ? `${atMentionPath}${atMentionHighlightedEntry.name}/` : `${atMentionHighlightedEntry.name}/`;
                      handleAtMentionDrillInto(newPath);
                    } else {
                      const relativePath = atMentionPath ? `${atMentionPath}${atMentionHighlightedEntry.name}` : atMentionHighlightedEntry.name;
                      handleAtMentionSelectFile(relativePath);
                    }
                    return;
                  }



                  // If we're in slash mode, show suggestions + allow selecting with Enter.
                  if (commandOpen) {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setCommandOpen(false);
                      setCommandQuery("");
                      setCommandHighlightedIndex(0);
                      return;
                    }

                    // Desktop: arrow key navigation through command items
                    if (!isTouchDevice && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                      event.preventDefault();
                      const totalItems = isResumeMode
                        ? resumeCandidates.length
                        : isAgentMode
                          ? agentCandidates.length
                          : subCommandMode.active
                            ? subCommandMode.filtered.length
                            : commandSuggestions.length + extensionSuggestions.length + promptSuggestions.length + skillSuggestions.length;
                      if (totalItems === 0) return;
                      setCommandHighlightedIndex(prev => {
                        if (event.key === "ArrowDown") {
                          return prev < totalItems - 1 ? prev + 1 : 0;
                        }
                        return prev > 0 ? prev - 1 : totalItems - 1;
                      });
                      return;
                    }

                    // Desktop: Enter in sub-command mode executes the highlighted sub-command,
                    // or fills the input if the sub-command requires an argument (e.g. server name).
                    if (!isTouchDevice && event.key === "Enter" && !event.shiftKey && subCommandMode.active) {
                      const highlighted = subCommandMode.filtered[commandHighlightedIndex];
                      if (highlighted) {
                        event.preventDefault();
                        if (highlighted.requiresArg) {
                          setInput(`/${subCommandMode.parentCommand} ${highlighted.name} `);
                          setCommandQuery("");
                          setCommandOpen(false);
                          setCommandHighlightedIndex(0);
                          requestAnimationFrame(() => {
                            const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                            if (textarea) {
                              const len = textarea.value.length;
                              textarea.setSelectionRange(len, len);
                              textarea.focus();
                            }
                          });
                          return;
                        }
                        executeSlashCommand(`/${subCommandMode.parentCommand} ${highlighted.name}`);
                        setCommandHighlightedIndex(0);
                        return;
                      }
                    }

                    // Desktop: Enter fills textbox with highlighted command (doesn't execute)
                    if (!isTouchDevice && event.key === "Enter" && !event.shiftKey) {
                      if (isResumeMode) {
                        const highlighted = resumeCandidates[commandHighlightedIndex];
                        if (highlighted && onExec) {
                          event.preventDefault();
                          onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "resume_session", sessionPath: highlighted.path });
                          setInput("");
                          setCommandQuery("");
                          setCommandOpen(false);
                          setCommandHighlightedIndex(0);
                          return;
                        }
                      } else if (isAgentMode) {
                        const highlighted = agentCandidates[commandHighlightedIndex];
                        if (highlighted && onSpawnAgentSession) {
                          event.preventDefault();
                          onSpawnAgentSession({
                            name: highlighted.name,
                            description: highlighted.description,
                            systemPrompt: highlighted.content,
                          });
                          setInput("");
                          setCommandQuery("");
                          setCommandOpen(false);
                          setCommandHighlightedIndex(0);
                          return;
                        }
                      } else {
                        const combined = [...commandSuggestions, ...extensionSuggestions, ...promptSuggestions, ...skillSuggestions];
                        const highlighted = combined[commandHighlightedIndex];
                        if (highlighted) {
                          event.preventDefault();
                          setInput(`/${highlighted.name} `);
                          setCommandQuery("");
                          setCommandOpen(highlighted.name === "resume" || keepPopoverOpenNames.has(highlighted.name.toLowerCase()));
                          setCommandHighlightedIndex(0);
                          // Position cursor at end of filled text
                          requestAnimationFrame(() => {
                            const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                            if (textarea) {
                              const len = textarea.value.length;
                              textarea.setSelectionRange(len, len);
                            }
                          });
                          return;
                        }
                      }
                      // No highlighted match — fall through to execute the typed command
                    }

                    // Tab in agent mode: autocomplete the highlighted agent name into the text box
                    if (event.key === "Tab" && isAgentMode && agentCandidates.length > 0) {
                      event.preventDefault();
                      const highlighted = agentCandidates[commandHighlightedIndex] ?? agentCandidates[0];
                      if (highlighted) {
                        setInput(`/agents ${highlighted.name}`);
                        setCommandQuery("");
                        setCommandHighlightedIndex(0);
                        requestAnimationFrame(() => {
                          const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                          if (textarea) {
                            const len = textarea.value.length;
                            textarea.setSelectionRange(len, len);
                            textarea.focus();
                          }
                        });
                      }
                      return;
                    }

                    // Tab in sub-command mode: autocomplete the highlighted sub-command into the text box
                    if (event.key === "Tab" && subCommandMode.active && subCommandMode.filtered.length > 0) {
                      event.preventDefault();
                      const highlighted = subCommandMode.filtered[commandHighlightedIndex] ?? subCommandMode.filtered[0];
                      if (highlighted) {
                        setInput(`/${subCommandMode.parentCommand} ${highlighted.name}`);
                        setCommandQuery("");
                        setCommandOpen(false);
                        setCommandHighlightedIndex(0);
                        requestAnimationFrame(() => {
                          const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                          if (textarea) {
                            const len = textarea.value.length;
                            textarea.setSelectionRange(len, len);
                            textarea.focus();
                          }
                        });
                      }
                      return;
                    }

                    // Tab: autocomplete the highlighted command (or first match) and close the popover
                    if (event.key === "Tab" && (commandSuggestions.length > 0 || extensionSuggestions.length > 0 || promptSuggestions.length > 0 || skillSuggestions.length > 0)) {
                      event.preventDefault();
                      const combined = [...commandSuggestions, ...extensionSuggestions, ...promptSuggestions, ...skillSuggestions];
                      const highlighted = combined[commandHighlightedIndex] ?? combined[0];
                      if (highlighted) {
                        setInput(`/${highlighted.name} `);
                        setCommandQuery("");
                        setCommandOpen(highlighted.name === "resume" || keepPopoverOpenNames.has(highlighted.name.toLowerCase()));
                        setCommandHighlightedIndex(0);
                      }
                      return;
                    }
                  }

                  // On mobile (touch), don't execute slash commands on Enter —
                  // the user taps the send button instead, which routes through handleSubmit.
                  if (isTouchDevice) return;

                  // Minimal slash-command exec for supported commands.
                  if (event.key !== "Enter" || event.shiftKey) return;

                  const trimmed = event.currentTarget.value.trim();
                  if (!trimmed.startsWith("/")) return;

                  if (executeSlashCommand(trimmed)) {
                    event.preventDefault();
                    return;
                  }
                }}
                disabled={!sessionId || isCompacting}
                submitOnEnter={!isTouchDevice}
                placeholder={
                  sessionId
                    ? isCompacting
                      ? "Compacting…"
                      : agentActive
                        ? deliveryMode === "steer"
                          ? "Type to steer the agent…"
                          : "Type a follow-up message…"
                        : isTouchDevice
                          ? "Send a message…"
                          : "Send a message to this session…"
                    : "Pick a session to chat"
                }
                className="min-h-12 max-h-36"
              />
            </div>
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              {sessionId && onShowModelSelector ? (
                <button
                  type="button"
                  onClick={onShowModelSelector}
                  className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/60 transition-colors min-w-0 max-w-[40vw]"
                >
                  {activeModel?.provider && (
                    <ProviderIcon provider={activeModel.provider} className="size-3 shrink-0" />
                  )}
                  <span className="truncate">
                    {activeModel ? `${activeModel.provider}/${activeModel.id}` : "Select model"}
                  </span>
                  <ChevronsUpDown className="size-3 opacity-50 shrink-0" />
                </button>
              ) : sessionId ? (
                <span className="px-2 text-xs text-muted-foreground">
                  Press Enter to send
                </span>
              ) : null}
              {sessionId && agentActive && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDeliveryMode((m) => m === "steer" ? "followUp" : "steer")}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-medium transition-colors border",
                      deliveryMode === "steer"
                        ? "bg-amber-500/15 text-amber-500 border-amber-500/30 hover:bg-amber-500/25"
                        : "bg-blue-500/15 text-blue-500 border-blue-500/30 hover:bg-blue-500/25",
                    )}
                    title={deliveryMode === "steer"
                      ? "Steer: interrupts agent mid-run (click to switch to follow-up)"
                      : "Follow-up: waits until agent finishes (click to switch to steer)"
                    }
                  >
                    {deliveryMode === "steer" ? (
                      <><Zap className="size-3" /> Steer</>
                    ) : (
                      <><Clock className="size-3" /> Follow-up</>
                    )}
                  </button>
                  <span className="text-[0.65rem] text-muted-foreground hidden sm:inline">
                    {deliveryMode === "steer" ? "Interrupts agent" : "Queued after agent"}
                  </span>
                </div>
              )}

            </PromptInputTools>
            <div className="flex items-center gap-0.5">
              <ComposerAttachmentButton />
              <ComposerSubmitButton
                sessionId={sessionId}
                input={input}
                agentActive={agentActive}
                onExec={onExec}
                isTouchDevice={isTouchDevice}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>

      {/* Clear confirmation dialog — shown on mobile only */}
      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Start a new conversation?</DialogTitle>
            <DialogDescription>
              This will clear the current conversation and start fresh.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setShowClearDialog(false);
                if (onExec) {
                  onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "new_session" });
                }
              }}
            >
              Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEndSessionDialog} onOpenChange={setShowEndSessionDialog}>
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End this session?</DialogTitle>
            <DialogDescription>
              This will permanently end the session. You won't be able to resume it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEndSessionDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowEndSessionDialog(false);
                if (onExec && sessionId) {
                  onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "end_session" });
                }
              }}
            >
              End Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </McpToggleContext.Provider>
    </SessionActionsProvider>
  );
}
