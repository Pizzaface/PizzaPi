import * as React from "react";

import { McpOAuthPaste } from "@/components/McpOAuthPaste";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  WideNearBottomStick,
  ConversationEmptyState,
  ConversationExport,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
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
import { cn } from "@/lib/utils";
import { PizzaLogo } from "@/components/PizzaLogo";
import {
  canSubmitSessionInput,
  getSessionEmptyStateUi,
  isSessionHydrating,
  shouldShowSessionTranscript,
} from "@/lib/session-empty-state";
import { formatPathTail } from "@/lib/path";
import { ProviderIcon } from "@/components/ProviderIcon";
import { MultipleChoiceQuestions } from "@/components/ai-elements/multiple-choice";
import { PlanModePanel, type PlanModeAnswer } from "@/components/ai-elements/plan-mode";
import { formatAnswersForAgent } from "@/lib/ask-user-questions";
import { exportToMarkdown } from "@/lib/export-markdown";
import { dismissNotificationsForSession } from "@/lib/push";
import {
  AlertTriangleIcon,
  BookOpen,
  Bot,
  ChevronsUpDown,
  Clock,
  Copy,
  FolderTree,
  GitBranch,
  Loader2,
  MessageSquare,
  OctagonX,
  Plus,
  Puzzle,
  ShieldAlert,
  TerminalIcon,
  Trash2,
  X,
  Zap,
  Pencil,
} from "lucide-react";
import { AtMentionPopover } from "@/components/AtMentionPopover";
import { McpToggleContext } from "@/components/session-viewer/McpToggleContext";
import { SessionActionsProvider } from "@/components/session-viewer/session-actions-context";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { type IncompleteTriggerItem } from "@/components/TriggersPanel";
import { resolveCommandPopoverState } from "@/components/session-viewer/utils";

import { ContextDonut } from "@/components/session-viewer/rendering";

// ── Sub-module imports ────────────────────────────────────────────────────────
import type { SessionViewerProps as BaseSessionViewerProps, CmdEntry } from "@/components/session-viewer/viewer-types";
import { formatTokenCount } from "@/components/session-viewer/formatters";
import { useMessageProcessor } from "@/components/session-viewer/message-processor";
import { useDraftManagement } from "@/components/session-viewer/draft-management";
import { useSessionActionsSetup } from "@/components/session-viewer/session-actions";
import { useAtMentionHandlers } from "@/components/session-viewer/at-mention-handlers";
import { useSlashCommands } from "@/components/session-viewer/slash-commands";
import { useAgentLoading } from "@/components/session-viewer/agent-loading";
import {
  HeartbeatStaleBadge,
  HeaderOverflowMenu,
  ComposerAttachmentButton,
  ComposerAttachments,
} from "@/components/session-viewer/header-badge";
import { ComposerSubmitButton } from "@/components/session-viewer/composer-submit";
import { SessionMessageItem, PaginationSentinel } from "@/components/session-viewer/message-item";

// ── Public re-exports (existing consumers import these from SessionViewer) ────
export type { RelayMessage } from "@/components/session-viewer/types";
export type { TodoItem, TokenUsage, QueuedMessage, ResumeSessionOption } from "@/lib/types";
export type { SessionViewerProps } from "@/components/session-viewer/viewer-types";

// ── Main component ────────────────────────────────────────────────────────────

export function SessionViewer({
  sessionId,
  sessionName,
  messages,
  activeModel,
  activeToolCalls,
  pendingQuestion,
  pendingPlan,
  pluginTrustPrompt,
  onPluginTrustResponse,
  availableCommands,
  resumeSessions,
  resumeSessionsLoading,
  onRequestResumeSessions,
  onSendInput,
  onExec,
  onShowModelSelector,
  agentActive,
  isCompacting,
  effortLevel,
  tokenUsage,
  lastHeartbeatAt,
  viewerStatus,
  retryState,
  messageQueue,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  onClearMessageQueue,
  onToggleTerminal,
  showTerminalButton,
  onToggleFileExplorer,
  showFileExplorerButton,
  onToggleGit,
  showGitButton,
  isTerminalOpen,
  isFileExplorerOpen,
  isGitOpen,
  onToggleTriggers,
  showTriggersButton,
  isTriggersOpen,
  triggerCount,
  todoList = [],
  planModeEnabled,
  runnerId,
  sessionCwd,
  onAppendSystemMessage,
  onSpawnAgentSession,
  onTriggerResponse,
  onQuestionDismiss,
  onPlanDismiss,
  onDuplicateSession,
  runnerInfo,
  extraHeaderButtons,
  mcpOAuthPastes,
  onMcpOAuthPaste,
  onMcpOAuthPasteDismiss,
  onMcpServerDisable,
  hasMoreServerMessages,
  onLoadMoreServerMessages,
  loadingOlderMessages,
}: BaseSessionViewerProps & {
  hasMoreServerMessages?: boolean;
  onLoadMoreServerMessages?: () => void;
  loadingOlderMessages?: boolean;
}) {
  // ── Misc local state ──────────────────────────────────────────────────────
  const [composerError, setComposerError] = React.useState<string | null>(null);

  const sendActionSigilResponse = React.useCallback(
    async (text: string): Promise<boolean> => {
      if (!onSendInput || !sessionId) return false;
      try {
        const result = await Promise.resolve(onSendInput(text));
        return result !== false;
      } catch {
        return false;
      }
    },
    [onSendInput, sessionId],
  );
  const [showEndSessionDialog, setShowEndSessionDialog] = React.useState(false);
  const [incompleteTriggers, setIncompleteTriggers] = React.useState<IncompleteTriggerItem[]>([]);
  const [showIncompleteTriggerDialog, setShowIncompleteTriggerDialog] = React.useState(false);
  const pendingTriggerActionRef = React.useRef<(() => void) | null>(null);
  const compactingRef = React.useRef(false);
  const sessionIdRef = React.useRef<string | null>(sessionId);
  const [editingQueuedId, setEditingQueuedId] = React.useState<string | null>(null);
  const [editingQueuedText, setEditingQueuedText] = React.useState("");

  // Keep sessionIdRef current for async callbacks
  React.useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Detect touch devices for mobile-specific behavior
  const isTouchDevice = React.useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  // ── Draft management (per-session draft text + delivery mode) ─────────────
  const { input, setInput, deliveryMode, setDeliveryMode } = useDraftManagement(sessionId);

  // ── Input ref for @-mention handlers (always sync with latest render) ───────
  const inputRef = React.useRef(input);
  inputRef.current = input; // assign directly in render body — always up-to-date

  // ── Session-switch side effects (reset popover/error state) ──────────────
  // (draft save/restore is handled by useDraftManagement internally)
  React.useEffect(() => {
    setComposerError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Available commands split by source ────────────────────────────────────
  const webHandledCommandNames = React.useMemo(
    () =>
      new Set([
        "new", "resume", "mcp", "plugins", "skills", "agents", "model",
        "cycle_model", "effort", "cycle_effort", "compact", "name", "copy",
        "stop", "restart", "remote", "plan", "sandbox",
      ]),
    [],
  );

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
      if (webHandledCommandNames.has(c.name.toLowerCase())) continue;
      if (c.source === "skill") skill.push(c);
      else if (c.source === "prompt") prompt.push(c);
      else ext.push(c);
    }
    return { extensionCommands: ext, skillCommands: skill, promptCommands: prompt };
  }, [availableCommands, webHandledCommandNames]);

  // ── Incomplete triggers callback for /new and /resume guards ─────────────
  const handleIncompleteTriggers = React.useCallback(
    (incomplete: IncompleteTriggerItem[], action: () => void) => {
      pendingTriggerActionRef.current = action;
      setIncompleteTriggers(incomplete);
      setShowIncompleteTriggerDialog(true);
    },
    [],
  );

  // ── Slash commands ────────────────────────────────────────────────────────
  const slashCmd = useSlashCommands(input, setInput, {
    sessionId,
    sessionIdRef,
    compactingRef,
    onExec,
    onSendInput,
    resumeSessions,
    onRequestResumeSessions,
    runnerId,
    sessionCwd,
    onAppendSystemMessage,
    onShowModelSelector,
    isCompacting,
    onSpawnAgentSession,
    runnerInfo,
    skillCommands,
    extensionCommands,
    promptCommands,
    onIncompleteTriggers: handleIncompleteTriggers,
  });

  const {
    commandOpen,
    setCommandOpen,
    commandQuery,
    setCommandQuery,
    commandHighlightedIndex,
    setCommandHighlightedIndex,
    executeSlashCommand,
    supportedWebCommands,
    knownCommandNames,
    keepPopoverOpenNames,
    commandSuggestions,
    skillSuggestions,
    extensionSuggestions,
    promptSuggestions,
    isResumeMode,
    isAgentMode,
    resumeCandidates,
    checkTriggersAndRun,
    requestNewSession,
    subCommandMode,
    trimmedInput,
  } = slashCmd;

  // ── Agent loading ─────────────────────────────────────────────────────────
  const agentQuery = isAgentMode
    ? trimmedInput.replace(/^\/agents\s*/i, "").trim().toLowerCase()
    : "";

  const { agentsList, agentsLoading, agentCandidates } = useAgentLoading({
    sessionId,
    runnerId,
    runnerInfo,
    commandOpen,
    isAgentMode,
    agentQuery,
  });

  // ── @-mention handlers ────────────────────────────────────────────────────
  const atMention = useAtMentionHandlers(sessionId, inputRef, setInput, runnerId, runnerInfo);

  const {
    atMentionOpen,
    setAtMentionOpen,
    atMentionPath,
    setAtMentionPath,
    atMentionQuery,
    setAtMentionQuery,
    atMentionTriggerOffset,
    setAtMentionTriggerOffset,
    atMentionHighlightedIndex,
    setAtMentionHighlightedIndex,
    atMentionHighlightedEntry,
    setAtMentionHighlightedEntry,
    atMentionHighlightedAgent,
    setAtMentionHighlightedAgent,
    atMentionAgents,
    handleAtMentionSelectFile,
    handleAtMentionDrillInto,
    handleAtMentionBack,
    handleAtMentionClose,
    handleAtMentionSelectAgent,
  } = atMention;

  // ── Message processing ────────────────────────────────────────────────────
  const { sortedMessages, visibleMessages, renderedMessages, hasMore, loadMoreMessages } =
    useMessageProcessor(messages, sessionId);

  // ── Session actions + MCP toggle context ─────────────────────────────────
  const { sessionActions, handleMcpToggle } = useSessionActionsSetup(onExec);

  // ── Compacting guard reset ────────────────────────────────────────────────
  React.useEffect(() => {
    if (!isCompacting) compactingRef.current = false;
  }, [isCompacting]);

  // ── Esc → abort ───────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!agentActive || !onExec) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showEndSessionDialog || showIncompleteTriggerDialog || commandOpen || atMentionOpen) return;
      e.preventDefault();
      onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "abort" });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [agentActive, onExec, showEndSessionDialog, showIncompleteTriggerDialog, commandOpen, atMentionOpen]);

  // ── Dismiss notifications when question is visible ────────────────────────
  React.useEffect(() => {
    if (pendingQuestion && sessionId) {
      void dismissNotificationsForSession(sessionId);
    }
  }, [pendingQuestion, sessionId]);

  // ── Highlighted command value (for cmdk data-selected) ───────────────────
  const commandHighlightedValue = React.useMemo(() => {
    if (!commandOpen) return "";
    if (isResumeMode) return resumeCandidates[commandHighlightedIndex]?.path ?? "";
    if (isAgentMode) return agentCandidates[commandHighlightedIndex]?.name ?? "";
    if (subCommandMode.active)
      return subCommandMode.filtered[commandHighlightedIndex]?.name ?? "";
    const combined = [
      ...commandSuggestions,
      ...extensionSuggestions,
      ...promptSuggestions,
      ...skillSuggestions,
    ];
    return combined[commandHighlightedIndex]?.name ?? "";
  }, [
    commandOpen,
    isResumeMode,
    isAgentMode,
    subCommandMode,
    resumeCandidates,
    agentCandidates,
    commandSuggestions,
    extensionSuggestions,
    promptSuggestions,
    skillSuggestions,
    commandHighlightedIndex,
  ]);

  const composerReady = canSubmitSessionInput(sessionId, viewerStatus, !!isCompacting);

  // ── handleSubmit ──────────────────────────────────────────────────────────
  const handleSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      if (!composerReady) {
        if (isSessionHydrating(viewerStatus)) {
          setComposerError("Session is still connecting — wait a moment and try again.");
        }
        return;
      }
      const text = message.text.trim();
      const hasAttachments = Array.isArray(message.files) && message.files.length > 0;
      if (!text && !hasAttachments) return;

      setComposerError(null);
      if (text && executeSlashCommand(text)) return;
      if (!onSendInput) return;

      const payload = agentActive ? { ...message, deliverAs: deliveryMode } : message;
      const originSessionId = sessionId;
      const sentText = text;

      Promise.resolve(onSendInput(payload))
        .then((result) => {
          if (result !== false) {
            if (sessionIdRef.current === originSessionId) {
              setInput("");
              setCommandOpen(false);
              setCommandQuery("");
            } else if (originSessionId) {
              // User switched away — only clear draft if it still matches sent text
              const saved = inputRef.current.trim();
              if (saved === sentText || saved === "") {
                setInput("");
              }
            }
          } else {
            setComposerError("Failed to send message.");
          }
        })
        .catch(() => { setComposerError("Failed to send message."); });
    },
    [composerReady, viewerStatus, executeSlashCommand, onSendInput, agentActive, deliveryMode, setInput, setCommandOpen, setCommandQuery, sessionIdRef, inputRef],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <SessionActionsProvider value={sessionActions}>
      <McpToggleContext.Provider value={onExec ? handleMcpToggle : null}>
        <div className="flex flex-col flex-1 min-h-0">

          {/* ── Session info bar ─────────────────────────────────────────── */}
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
                  isCompacting
                    ? "Compacting context…"
                    : agentActive
                      ? "Agent active"
                      : lastHeartbeatAt
                        ? "Agent idle"
                        : "No heartbeat yet"
                }
              />

              {/* Transient status */}
              {viewerStatus &&
                viewerStatus !== "Connected" &&
                viewerStatus !== "Idle" &&
                viewerStatus !== "Connecting…" && (
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

              {/* Right: badges + actions */}
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
                        onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "set_plan_mode", enabled: false } as unknown as Parameters<typeof onExec>[0]);
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="hidden md:inline-flex h-7 w-7" onClick={onToggleTerminal} size="icon" type="button" variant="outline" aria-label="Toggle terminal">
                        <TerminalIcon className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Terminal</TooltipContent>
                  </Tooltip>
                )}
                {showFileExplorerButton && onToggleFileExplorer && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="hidden md:inline-flex h-7 w-7" onClick={onToggleFileExplorer} size="icon" type="button" variant="outline" aria-label="Toggle file explorer">
                        <FolderTree className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Files</TooltipContent>
                  </Tooltip>
                )}
                {showGitButton && onToggleGit && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="hidden md:inline-flex h-7 w-7" onClick={onToggleGit} size="icon" type="button" variant="outline" aria-label="Toggle git panel">
                        <GitBranch className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Git</TooltipContent>
                  </Tooltip>
                )}
                {showTriggersButton && onToggleTriggers && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="hidden md:inline-flex h-7 w-7 relative" onClick={onToggleTriggers} size="icon" type="button" variant="outline" aria-label="Toggle triggers panel">
                        <Zap className="size-3.5" />
                        {((triggerCount?.pending ?? 0) > 0 || (triggerCount?.subscriptions ?? 0) > 0) && (
                          <span className="absolute -top-1.5 -right-1.5 flex items-center gap-px">
                            {(triggerCount?.pending ?? 0) > 0 && (
                              <span className="flex items-center justify-center min-w-[14px] h-3.5 rounded-full bg-amber-500 text-[9px] font-bold text-black px-0.5 leading-none">
                                {triggerCount!.pending > 9 ? "9+" : triggerCount!.pending}
                              </span>
                            )}
                            {(triggerCount?.subscriptions ?? 0) > 0 && (
                              <span className="flex items-center justify-center min-w-[14px] h-3.5 rounded-full bg-blue-500 text-[9px] font-bold text-white px-0.5 leading-none">
                                {triggerCount!.subscriptions > 9 ? "9+" : triggerCount!.subscriptions}
                              </span>
                            )}
                          </span>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Triggers
                      {(triggerCount?.pending ?? 0) > 0 && ` • ${triggerCount!.pending} pending`}
                      {(triggerCount?.subscriptions ?? 0) > 0 && ` • ${triggerCount!.subscriptions} subscribed`}
                    </TooltipContent>
                  </Tooltip>
                )}
                {extraHeaderButtons}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ConversationExport
                      messages={sortedMessages}
                      filename={`session-${sessionId || "export"}.md`}
                      className="static top-auto right-auto hidden md:inline-flex h-7 w-7 border-border bg-background hover:bg-accent hover:text-accent-foreground rounded-md"
                      variant="outline"
                      size="icon"
                    />
                  </TooltipTrigger>
                  <TooltipContent>Export</TooltipContent>
                </Tooltip>
                {onDuplicateSession && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="hidden md:inline-flex h-7 w-7" onClick={onDuplicateSession} size="icon" type="button" variant="outline" aria-label="Duplicate session">
                        <Copy className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Duplicate</TooltipContent>
                  </Tooltip>
                )}
                <HeaderOverflowMenu
                  showTerminalButton={showTerminalButton}
                  onToggleTerminal={onToggleTerminal}
                  isTerminalOpen={isTerminalOpen}
                  showFileExplorerButton={showFileExplorerButton}
                  onToggleFileExplorer={onToggleFileExplorer}
                  isFileExplorerOpen={isFileExplorerOpen}
                  showGitButton={showGitButton}
                  onToggleGit={onToggleGit}
                  isGitOpen={isGitOpen}
                  showTriggersButton={showTriggersButton}
                  onToggleTriggers={onToggleTriggers}
                  isTriggersOpen={isTriggersOpen}
                  triggerCount={triggerCount}
                  onDuplicateSession={onDuplicateSession}
                  messages={sortedMessages}
                  sessionId={sessionId}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="h-7 w-7"
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
                      aria-label="End session"
                    >
                      <OctagonX className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>End Session</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="h-7 w-7"
                      disabled={!onExec}
                      onClick={() => { void requestNewSession(); }}
                      size="icon"
                      type="button"
                      variant="outline"
                      aria-label="New conversation"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New Conversation</TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}

          {/* ── Conversation area ─────────────────────────────────────────── */}
          <div className="relative flex flex-col flex-1 min-h-0">
            {!sessionId ? (
              <ConversationEmptyState
                icon={<MessageSquare className="size-8 opacity-40" />}
                title="No session selected"
                description="Open the sidebar and pick a session to get started."
              />
            ) : shouldShowSessionTranscript(sessionId, viewerStatus, visibleMessages.length > 0) ? (
              <Conversation key={sessionId} className="overflow-x-hidden">
                <ConversationContent className="w-full gap-0 p-0 py-2">
                  <PaginationSentinel
                    hasMore={hasMore || !!hasMoreServerMessages}
                    onLoadMore={() => {
                      if (hasMore) loadMoreMessages();
                      else if (hasMoreServerMessages && onLoadMoreServerMessages) onLoadMoreServerMessages();
                    }}
                    loading={loadingOlderMessages}
                  />
                  {renderedMessages.map((message, index) => (
                    <SessionMessageItem
                      key={message.key}
                      message={message}
                      activeToolCalls={activeToolCalls}
                      agentActive={agentActive}
                      isLast={index === renderedMessages.length - 1}
                      onTriggerResponse={onTriggerResponse}
                      onActionSigilResponse={sendActionSigilResponse}
                    />
                  ))}
                </ConversationContent>
                <WideNearBottomStick />
                <ConversationScrollButton />
              </Conversation>
            ) : (() => {
              const emptyUi = getSessionEmptyStateUi(viewerStatus);
              return (
                <ConversationEmptyState
                  icon={
                    <span
                      className={cn(
                        "inline-flex items-center justify-center h-11 w-11 rounded-full bg-muted/60 border border-border/60",
                        emptyUi.shouldSpinLogo && "animate-spin motion-reduce:animate-none",
                      )}
                    >
                      <PizzaLogo className="h-7 w-7 sm:h-8 sm:w-8 pointer-events-none cursor-default select-none" />
                    </span>
                  }
                  title={emptyUi.title}
                  description={emptyUi.description}
                />
              );
            })()}
          </div>

          {/* ── Composer area ─────────────────────────────────────────────── */}
          <div className="border-t border-border bg-background px-3 py-2 pp-safe-bottom">

            {/* Message queue */}
            {sessionId && messageQueue && messageQueue.length > 0 && (
              <div className="mb-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide">
                    Queued messages ({messageQueue.length})
                  </span>
                  {onClearMessageQueue && (
                    <button type="button" onClick={onClearMessageQueue} className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground hover:text-destructive transition-colors" title="Clear all queued messages">
                      <Trash2 className="size-3" />
                      Clear
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {messageQueue.map((qm) => (
                    <div key={qm.id} className="flex flex-col gap-1 text-xs group">
                      <div className="flex items-start gap-2">
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide flex-shrink-0 mt-0.5",
                          qm.deliverAs === "steer"
                            ? "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                            : "bg-blue-500/15 text-blue-500 border border-blue-500/30",
                        )}>
                          {qm.deliverAs === "steer" ? (
                            <><Zap className="size-2.5" /> Steer</>
                          ) : (
                            <><Clock className="size-2.5" /> Follow-up</>
                          )}
                        </span>
                        {editingQueuedId === qm.id ? (
                          <div className="flex-1 flex flex-col gap-1">
                            <textarea
                              className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs text-foreground leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
                              rows={2}
                              value={editingQueuedText}
                              onChange={(e) => setEditingQueuedText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  const trimmed = editingQueuedText.trim();
                                  if (trimmed && onEditQueuedMessage) onEditQueuedMessage(qm.id, trimmed);
                                  setEditingQueuedId(null);
                                  setEditingQueuedText("");
                                } else if (e.key === "Escape") {
                                  setEditingQueuedId(null);
                                  setEditingQueuedText("");
                                }
                              }}
                              autoFocus
                            />
                            <div className="flex items-center gap-1.5">
                              <button type="button" onClick={() => {
                                const trimmed = editingQueuedText.trim();
                                if (trimmed && onEditQueuedMessage) onEditQueuedMessage(qm.id, trimmed);
                                setEditingQueuedId(null);
                                setEditingQueuedText("");
                              }} className="text-[0.65rem] px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">Save</button>
                              <button type="button" onClick={() => { setEditingQueuedId(null); setEditingQueuedText(""); }} className="text-[0.65rem] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <span className="truncate flex-1 text-foreground/80 leading-relaxed">{qm.text}</span>
                            <div className="flex items-center gap-1 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-all">
                              {onEditQueuedMessage && (
                                <button type="button" onClick={() => { setEditingQueuedId(qm.id); setEditingQueuedText(qm.text); }} className="text-muted-foreground hover:text-foreground transition-colors" title="Edit queued message" aria-label="Edit queued message">
                                  <Pencil className="size-3" />
                                </button>
                              )}
                              {onRemoveQueuedMessage && (
                                <button type="button" onClick={() => onRemoveQueuedMessage(qm.id)} className="text-muted-foreground hover:text-destructive transition-colors" title="Remove queued message" aria-label="Remove queued message">
                                  <X className="size-3" />
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {retryState && agentActive && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                <Clock className="size-3.5 shrink-0 animate-spin" style={{ animationDuration: "3s" }} />
                <span><span className="font-semibold">Auto-retrying:</span> {retryState.errorMessage}</span>
              </div>
            )}

            {/* Plugin trust prompt */}
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
                        <span key={pluginTrustPrompt.pluginNames[i]} className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-mono text-amber-700 dark:text-amber-400 ring-1 ring-amber-500/20">
                          {summary}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button type="button" className="inline-flex items-center rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-amber-600 transition-colors" onClick={() => onPluginTrustResponse(true)}>Trust &amp; Load</button>
                      <button type="button" className="inline-flex items-center rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80 transition-colors" onClick={() => onPluginTrustResponse(false)}>Skip</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Multiple-choice questions */}
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
                        if (sessionId) void dismissNotificationsForSession(sessionId);
                        onQuestionDismiss?.();
                        return true;
                      }
                      setComposerError("Failed to send answer.");
                      return false;
                    })
                    .catch(() => { setComposerError("Failed to send answer."); return false; });
                }}
              />
            )}

            {/* Plan mode review panel */}
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
                        onPlanDismiss?.();
                        return true;
                      }
                      setComposerError("Failed to send plan response.");
                      return false;
                    })
                    .catch(() => { setComposerError("Failed to send plan response."); return false; });
                }}
              />
            )}

            {/* Command picker */}
            {sessionId && commandOpen && (
              <div className="mb-2 rounded-md border border-border bg-popover text-popover-foreground shadow-sm">
                <Command
                  shouldFilter={false}
                  className="w-full"
                  value={commandHighlightedValue}
                  onValueChange={(v) => {
                    if (isResumeMode) {
                      const idx = resumeCandidates.findIndex((s) => s.path.toLowerCase() === v.toLowerCase());
                      if (idx !== -1) setCommandHighlightedIndex(idx);
                    } else if (isAgentMode) {
                      const idx = agentCandidates.findIndex((a) => a.name.toLowerCase() === v.toLowerCase());
                      if (idx !== -1) setCommandHighlightedIndex(idx);
                    } else if (subCommandMode.active) {
                      const idx = subCommandMode.filtered.findIndex((sc) => sc.name.toLowerCase() === v.toLowerCase());
                      if (idx !== -1) setCommandHighlightedIndex(idx);
                    } else {
                      const combined = [...commandSuggestions, ...extensionSuggestions, ...promptSuggestions, ...skillSuggestions];
                      const idx = combined.findIndex((c) => c.name.toLowerCase() === v.toLowerCase());
                      if (idx !== -1) setCommandHighlightedIndex(idx);
                    }
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
                    <span className="text-xs text-muted-foreground font-medium">
                      {isResumeMode ? "Resume session" : isAgentMode ? "Start as agent" : subCommandMode.active ? `/${subCommandMode.parentCommand}` : "Commands"}
                    </span>
                    <button type="button" onClick={() => { setCommandOpen(false); setCommandQuery(""); }} className="inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors" aria-label="Close command menu">
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <CommandList className="max-h-56">
                    {isResumeMode ? (
                      <>
                        <CommandEmpty>{resumeSessionsLoading ? "Loading sessions…" : "No sessions found"}</CommandEmpty>
                        <CommandGroup heading="Resume session">
                          {resumeCandidates.map((session) => (
                            <CommandItem key={session.path} value={session.path} onSelect={() => {
                              if (onExec) {
                                const path = session.path;
                                void checkTriggersAndRun(() => {
                                  onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "resume_session", sessionPath: path });
                                });
                              }
                              setInput("");
                              setCommandQuery("");
                              setCommandOpen(false);
                            }}>
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-mono text-sm truncate">{session.name || `Session ${session.id.slice(0, 8)}…`}</span>
                                  <span className="text-[11px] text-muted-foreground shrink-0">{new Date(session.modified).toLocaleDateString()}</span>
                                </div>
                                <span className="text-[11px] text-muted-foreground truncate" title={session.path}>{formatPathTail(session.path, 2)}</span>
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
                            <CommandItem key={agent.name} value={agent.name} onSelect={() => {
                              if (onSpawnAgentSession) {
                                onSpawnAgentSession({ name: agent.name, description: agent.description, systemPrompt: agent.content });
                              }
                              setInput("");
                              setCommandQuery("");
                              setCommandOpen(false);
                            }}>
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <div className="flex items-center gap-2 min-w-0">
                                  <Bot className="size-3.5 shrink-0 text-primary/60" />
                                  <span className="font-mono text-sm truncate">{agent.name}</span>
                                </div>
                                {agent.description && <span className="text-[11px] text-muted-foreground truncate">{agent.description}</span>}
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
                            <CommandItem key={sc.name} value={sc.name} onSelect={() => {
                              if (sc.requiresArg) {
                                setInput(`/${subCommandMode.parentCommand} ${sc.name} `);
                                setCommandQuery("");
                                setCommandOpen(false);
                                setCommandHighlightedIndex(0);
                                requestAnimationFrame(() => {
                                  const ta = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                                  if (ta) { const len = ta.value.length; ta.setSelectionRange(len, len); ta.focus(); }
                                });
                                return;
                              }
                              executeSlashCommand(`/${subCommandMode.parentCommand} ${sc.name}`);
                            }}>
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
                              <CommandItem key={cmd.name} value={cmd.name} onSelect={() => {
                                if (cmd.name === "new") { executeSlashCommand("/new"); return; }
                                setInput(`/${cmd.name} `);
                                setCommandQuery("");
                                setCommandOpen(keepPopoverOpenNames.has(cmd.name.toLowerCase()));
                                setCommandHighlightedIndex(0);
                              }}>
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
                              <CommandItem key={cmd.name} value={cmd.name} onSelect={() => {
                                setInput(`/${cmd.name} `);
                                setCommandQuery("");
                                setCommandOpen(false);
                                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]")?.focus());
                              }}>
                                <div className="flex w-full items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <Puzzle className="size-3.5 shrink-0 text-primary/60" />
                                    <span className="font-mono text-sm truncate">/{cmd.name}</span>
                                  </div>
                                  {cmd.description && <span className="text-xs text-muted-foreground truncate max-w-[50%]">{cmd.description}</span>}
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {promptSuggestions.length > 0 && (
                          <CommandGroup heading="Prompt Templates">
                            {promptSuggestions.map((cmd) => (
                              <CommandItem key={cmd.name} value={cmd.name} onSelect={() => {
                                setInput(`/${cmd.name} `);
                                setCommandQuery("");
                                setCommandOpen(false);
                                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]")?.focus());
                              }}>
                                <div className="flex w-full items-center justify-between gap-2">
                                  <span className="font-mono text-sm truncate">/{cmd.name}</span>
                                  {cmd.description && <span className="text-xs text-muted-foreground truncate max-w-[50%]">{cmd.description}</span>}
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {skillSuggestions.length > 0 && (
                          <CommandGroup heading="Skills">
                            {skillSuggestions.map((skill) => (
                              <CommandItem key={skill.name} value={skill.name} onSelect={() => {
                                setInput(`/${skill.name} `);
                                setCommandQuery("");
                                setCommandOpen(false);
                                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]")?.focus());
                              }}>
                                <div className="flex w-full items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <BookOpen className="size-3.5 shrink-0 text-primary/60" />
                                    <span className="font-mono text-sm truncate">/{skill.name}</span>
                                  </div>
                                  {skill.description && <span className="text-xs text-muted-foreground truncate max-w-[50%]">{skill.description}</span>}
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

            {/* @-mention popover */}
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
                  agents={atMentionAgents}
                  onSelectAgent={handleAtMentionSelectAgent}
                  onHighlightedAgentChange={setAtMentionHighlightedAgent}
                />
              </div>
            )}

            {isCompacting && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span>Compacting conversation history — input is disabled until complete</span>
              </div>
            )}

            {/* MCP OAuth paste prompts */}
            {mcpOAuthPastes && mcpOAuthPastes.length > 0 && onMcpOAuthPaste && (
              <div className="mb-2 flex flex-col gap-2">
                {mcpOAuthPastes.map((p) => (
                  <McpOAuthPaste
                    key={`${p.serverName}:${p.nonce}`}
                    serverName={p.serverName}
                    authUrl={p.authUrl}
                    nonce={p.nonce}
                    onSubmit={onMcpOAuthPaste}
                    onDismiss={onMcpOAuthPasteDismiss ?? (() => {})}
                    onDisable={onMcpServerDisable}
                  />
                ))}
              </div>
            )}

            {composerError && (
              <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                {composerError}
              </div>
            )}

            <PromptInput
              key={sessionId ?? "__none"}
              onSubmit={handleSubmit}
              maxFiles={8}
              maxFileSize={30 * 1024 * 1024}
              disabled={!composerReady}
              onError={(err) => { setComposerError(err.message); }}
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

                      const trimmed = next.trimStart();
                      if (trimmed.startsWith("/")) {
                        const { open, query } = resolveCommandPopoverState(trimmed.slice(1), knownCommandNames, keepPopoverOpenNames);
                        setCommandOpen(open);
                        setCommandQuery(query);
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

                      if (!runnerId) {
                        if (atMentionOpen) {
                          setAtMentionOpen(false);
                          setAtMentionQuery("");
                          setAtMentionPath("");
                          setAtMentionTriggerOffset(0);
                        }
                        return;
                      }

                      const cursorPos = event.currentTarget.selectionStart ?? next.length;
                      let lastAtIndex = -1;
                      for (let i = cursorPos - 1; i >= 0; i--) {
                        if (next[i] === "@") {
                          if (i === 0 || next[i - 1] === " " || next[i - 1] === "\n" || next[i - 1] === "\t") {
                            lastAtIndex = i;
                            break;
                          }
                        }
                      }

                      if (lastAtIndex === -1) {
                        if (atMentionOpen) {
                          setAtMentionOpen(false);
                          setAtMentionQuery("");
                          setAtMentionPath("");
                          setAtMentionTriggerOffset(0);
                        }
                        return;
                      }

                      const query = next.slice(lastAtIndex + 1, cursorPos);
                      const spaceInQuery = query.search(/\s/);
                      if (spaceInQuery !== -1) {
                        if (atMentionOpen) {
                          setAtMentionOpen(false);
                          setAtMentionQuery("");
                          setAtMentionPath("");
                          setAtMentionTriggerOffset(0);
                        }
                        return;
                      }

                      setAtMentionOpen(true);
                      setAtMentionTriggerOffset(lastAtIndex);
                      setAtMentionQuery(query);
                      const lastSlash = query.lastIndexOf("/");
                      if (lastSlash !== -1) {
                        setAtMentionPath(query.slice(0, lastSlash + 1));
                      } else {
                        setAtMentionPath("");
                      }
                    }}
                    onKeyDown={(event) => {
                      if (!sessionId) return;

                      if (event.key === "Enter" && event.altKey && agentActive) {
                        event.preventDefault();
                        setDeliveryMode((m) => m === "steer" ? "followUp" : "steer");
                        return;
                      }

                      if (atMentionOpen && event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        handleAtMentionClose();
                        return;
                      }

                      if (atMentionOpen && event.key === "Tab" && atMentionHighlightedEntry?.isDirectory) {
                        event.preventDefault();
                        event.stopPropagation();
                        const newPath = atMentionPath ? `${atMentionPath}${atMentionHighlightedEntry.name}/` : `${atMentionHighlightedEntry.name}/`;
                        handleAtMentionDrillInto(newPath);
                        return;
                      }

                      if (atMentionOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        const popoverEl = document.querySelector<HTMLElement>("[role='listbox'][aria-label='Mentions']");
                        if (popoverEl) {
                          popoverEl.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true, cancelable: true }));
                        }
                        return;
                      }

                      if (atMentionOpen && event.key === "Enter" && !event.shiftKey) {
                        if (atMentionHighlightedAgent) {
                          event.preventDefault();
                          event.stopPropagation();
                          handleAtMentionSelectAgent(atMentionHighlightedAgent);
                          return;
                        }
                        if (atMentionHighlightedEntry) {
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
                      }

                      if (commandOpen) {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setCommandOpen(false);
                          setCommandQuery("");
                          setCommandHighlightedIndex(0);
                          return;
                        }

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
                          setCommandHighlightedIndex((prev) => {
                            if (event.key === "ArrowDown") return prev < totalItems - 1 ? prev + 1 : 0;
                            return prev > 0 ? prev - 1 : totalItems - 1;
                          });
                          return;
                        }

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
                                const ta = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                                if (ta) { const len = ta.value.length; ta.setSelectionRange(len, len); ta.focus(); }
                              });
                              return;
                            }
                            executeSlashCommand(`/${subCommandMode.parentCommand} ${highlighted.name}`);
                            setCommandHighlightedIndex(0);
                            return;
                          }
                        }

                        if (!isTouchDevice && event.key === "Enter" && !event.shiftKey) {
                          if (isResumeMode) {
                            const highlighted = resumeCandidates[commandHighlightedIndex];
                            if (highlighted && onExec) {
                              event.preventDefault();
                              const path = highlighted.path;
                              void checkTriggersAndRun(() => {
                                onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "resume_session", sessionPath: path });
                              });
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
                              onSpawnAgentSession({ name: highlighted.name, description: highlighted.description, systemPrompt: highlighted.content });
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
                              requestAnimationFrame(() => {
                                const ta = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                                if (ta) { const len = ta.value.length; ta.setSelectionRange(len, len); }
                              });
                              return;
                            }
                          }
                        }

                        if (event.key === "Tab" && isAgentMode && agentCandidates.length > 0) {
                          event.preventDefault();
                          const highlighted = agentCandidates[commandHighlightedIndex] ?? agentCandidates[0];
                          if (highlighted) {
                            setInput(`/agents ${highlighted.name}`);
                            setCommandQuery("");
                            setCommandHighlightedIndex(0);
                            requestAnimationFrame(() => {
                              const ta = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                              if (ta) { const len = ta.value.length; ta.setSelectionRange(len, len); ta.focus(); }
                            });
                          }
                          return;
                        }

                        if (event.key === "Tab" && subCommandMode.active && subCommandMode.filtered.length > 0) {
                          event.preventDefault();
                          const highlighted = subCommandMode.filtered[commandHighlightedIndex] ?? subCommandMode.filtered[0];
                          if (highlighted) {
                            setInput(`/${subCommandMode.parentCommand} ${highlighted.name}`);
                            setCommandQuery("");
                            setCommandOpen(false);
                            setCommandHighlightedIndex(0);
                            requestAnimationFrame(() => {
                              const ta = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
                              if (ta) { const len = ta.value.length; ta.setSelectionRange(len, len); ta.focus(); }
                            });
                          }
                          return;
                        }

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

                      if (isTouchDevice) return;
                      if (event.key !== "Enter" || event.shiftKey) return;
                      const trimmedVal = event.currentTarget.value.trim();
                      if (!trimmedVal.startsWith("/")) return;
                      if (executeSlashCommand(trimmedVal)) { event.preventDefault(); }
                    }}
                    disabled={!composerReady}
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
                    <button type="button" onClick={onShowModelSelector} className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/60 transition-colors min-w-0 max-w-[40vw]">
                      {activeModel?.provider && <ProviderIcon provider={activeModel.provider} className="size-3 shrink-0" />}
                      <span className="truncate">{activeModel ? `${activeModel.provider}/${activeModel.id}` : "Select model"}</span>
                      <ChevronsUpDown className="size-3 opacity-50 shrink-0" />
                    </button>
                  ) : sessionId ? (
                    <span className="px-2 text-xs text-muted-foreground">Press Enter to send</span>
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
                        title={deliveryMode === "steer" ? "Steer: interrupts agent mid-run (click to switch to follow-up)" : "Follow-up: waits until agent finishes (click to switch to steer)"}
                      >
                        {deliveryMode === "steer" ? <><Zap className="size-3" /> Steer</> : <><Clock className="size-3" /> Follow-up</>}
                      </button>
                      <span className="text-[0.65rem] text-muted-foreground hidden sm:inline">
                        {deliveryMode === "steer" ? "Interrupts agent" : "Queued after agent"}
                      </span>
                    </div>
                  )}
                </PromptInputTools>
                <div className="flex items-center gap-0.5">
                  <ContextDonut
                    tokenUsage={tokenUsage}
                    contextWindow={activeModel?.contextWindow}
                    isCompacting={isCompacting}
                    onCompact={onExec ? () => {
                      onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "compact" });
                    } : undefined}
                  />
                  <ComposerAttachmentButton />
                  <ComposerSubmitButton sessionId={sessionId} input={input} agentActive={agentActive} onExec={onExec} isTouchDevice={isTouchDevice} />
                </div>
              </PromptInputFooter>
            </PromptInput>
          </div>

          {/* ── Dialogs ───────────────────────────────────────────────────── */}
          <Dialog open={showIncompleteTriggerDialog} onOpenChange={setShowIncompleteTriggerDialog}>
            <DialogContent showCloseButton={false} className="max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangleIcon className="size-4 text-amber-400" />
                  Active linked sessions
                </DialogTitle>
                <DialogDescription>
                  Starting a new conversation will disconnect these linked sessions. Their triggers will be lost.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto py-1">
                {incompleteTriggers.map((item) => (
                  <div key={item.source} className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate block">{item.label}</span>
                      <span className="text-xs text-muted-foreground">{item.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setShowIncompleteTriggerDialog(false); pendingTriggerActionRef.current = null; }}>Cancel</Button>
                <Button variant="destructive" onClick={() => {
                  setShowIncompleteTriggerDialog(false);
                  setIncompleteTriggers([]);
                  const action = pendingTriggerActionRef.current;
                  pendingTriggerActionRef.current = null;
                  action?.();
                }}>Clear anyway</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={showEndSessionDialog} onOpenChange={setShowEndSessionDialog}>
            <DialogContent showCloseButton={false} className="max-w-sm">
              <DialogHeader>
                <DialogTitle>End this session?</DialogTitle>
                <DialogDescription>This will permanently end the session. You won't be able to resume it.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowEndSessionDialog(false)}>Cancel</Button>
                <Button variant="destructive" onClick={() => {
                  setShowEndSessionDialog(false);
                  if (onExec && sessionId) {
                    onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "end_session" });
                  }
                }}>End Session</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

        </div>
      </McpToggleContext.Provider>
    </SessionActionsProvider>
  );
}
