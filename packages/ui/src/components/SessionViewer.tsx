import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import type { RelayMessage } from "@/components/session-viewer/types";
import { groupToolExecutionMessages } from "@/components/session-viewer/grouping";
import {
  hasVisibleContent,
} from "@/components/session-viewer/utils";
import {
  renderContent,
  roleLabel,
  toMessageRole,
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ArrowDownIcon, MessageSquare, PaperclipIcon } from "lucide-react";

export type { RelayMessage } from "@/components/session-viewer/types";

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

export interface SessionViewerProps {
  sessionId: string | null;
  sessionName?: string | null;
  messages: RelayMessage[];
  /** Active model info for the current session (used to show provider indicator) */
  activeModel?: { provider: string; id: string; name?: string; reasoning?: boolean } | null;
  activeToolCalls?: Map<string, string>;
  pendingQuestion?: { question: string; options?: string[] } | null;
  availableCommands?: Array<{ name: string; description?: string }>;
  resumeSessions?: ResumeSessionOption[];
  resumeSessionsLoading?: boolean;
  onRequestResumeSessions?: () => boolean | void;
  onSendInput?: (message: PromptInputMessage | string) => boolean | void | Promise<boolean | void>;
  onExec?: (payload: unknown) => boolean | void;
  /** Whether the agent is currently processing a turn */
  agentActive?: boolean;
  /** Current reasoning effort level (e.g. "low", "medium", "high", "off") */
  effortLevel?: string | null;
  /** Cumulative token usage for the session */
  tokenUsage?: TokenUsage | null;
  /** Unix ms timestamp of the most recent heartbeat from the CLI */
  lastHeartbeatAt?: number | null;
  /** Human-readable connection/activity status */
  viewerStatus?: string;
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
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={() => attachments.openFileDialog()}
      title="Add attachments"
    >
      <PaperclipIcon className="size-3.5" />
      Attach
    </Button>
  );
}

function ComposerSubmitButton({
  sessionId,
  input,
  agentActive,
  onExec,
}: {
  sessionId: string | null;
  input: string;
  agentActive?: boolean;
  onExec?: (payload: unknown) => boolean | void;
}) {
  const attachments = usePromptInputAttachments();
  const hasAttachments = attachments.files.length > 0;

  return (
    <PromptInputSubmit
      status={agentActive && onExec ? "streaming" : "ready"}
      onStop={
        onExec
          ? () => {
              onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "abort" });
            }
          : undefined
      }
      disabled={!sessionId || (!(agentActive && onExec) && !input.trim() && !hasAttachments)}
    />
  );
}

const SessionMessageItem = React.memo(({ message, activeToolCalls, agentActive, isLast }: {
  message: RelayMessage;
  activeToolCalls?: Map<string, string>;
  agentActive?: boolean;
  isLast: boolean;
}) => {
  return (
    <div className="w-full px-4 py-1.5">
      <Message from={toMessageRole(message.role)}>
        <MessageContent
          className={cn(
            "pp-message-content max-w-3xl min-w-0 rounded-lg border px-3 py-2 break-words",
            message.role === "user"
              ? "ml-auto bg-primary text-primary-foreground border-primary/40"
              : "bg-card text-card-foreground border-border",
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
            agentActive && isLast,
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

export function SessionViewer({ sessionId, sessionName, messages, activeModel, activeToolCalls, pendingQuestion, availableCommands, resumeSessions, resumeSessionsLoading, onRequestResumeSessions, onSendInput, onExec, agentActive, effortLevel, tokenUsage, lastHeartbeatAt, viewerStatus }: SessionViewerProps) {
  const [input, setInput] = React.useState("");
  const [composerError, setComposerError] = React.useState<string | null>(null);

  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");

  React.useEffect(() => {
    if (!sessionId) {
      setInput("");
    }
    setComposerError(null);
  }, [sessionId]);

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

    if (!onExec) return false;

    if (rawCommand === "mcp" || rawCommand === "mcp_reload") {
      const action = rawCommand === "mcp_reload" || args.trim().toLowerCase() === "reload" ? "reload" : "status";
      onExec({ type: "exec", id, command: "mcp", action });
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
      onExec({ type: "exec", id, command: "cycle_model" });
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
      onExec({ type: "exec", id, command: "compact", customInstructions: args || undefined });
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

    return false;
  }, [onExec, onSendInput, resumeSessions]);

  const handleSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      const hasAttachments = Array.isArray(message.files) && message.files.length > 0;
      if ((!text && !hasAttachments) || !sessionId) return;

      setComposerError(null);

      if (text && executeSlashCommand(text)) return;
      if (!onSendInput) return;

      Promise.resolve(onSendInput(message))
        .then((result) => {
          if (result !== false) setInput("");
          else setComposerError("Failed to send message.");
        })
        .catch(() => {
          setComposerError("Failed to send message.");
        });
    },
    [executeSlashCommand, onSendInput, sessionId],
  );

  const supportedWebCommands = React.useMemo(() => {
    // Only include commands that we actually intercept/execute via exec.
    // (availableCommands contains prompt templates, skills, etc. which we don't exec.)
    return [
      { name: "new", description: "Start a new conversation" },
      { name: "resume", description: "Resume the previous session" },
      { name: "mcp", description: "Show MCP status" },
      { name: "mcp_reload", description: "Reload MCP tools" },
      { name: "model", description: "Cycle model" },
      { name: "cycle_model", description: "Cycle model" },
      { name: "effort", description: "Cycle reasoning effort level" },
      { name: "cycle_effort", description: "Cycle reasoning effort level" },
      { name: "compact", description: "Compact context" },
      { name: "name", description: "Set session name" },
      { name: "copy", description: "Copy last assistant message" },
      { name: "stop", description: "Abort current generation" },
      { name: "restart", description: "Restart the CLI process" },
    ];
  }, []);

  const commandSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const list = supportedWebCommands;
    if (!query) return list;
    return list.filter((c) => c.name.toLowerCase().includes(query));
  }, [commandQuery, supportedWebCommands]);

  const trimmedInput = input.trimStart();
  const isResumeMode = /^\/resume(?:\s|$)/i.test(trimmedInput);
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

  const resumeRequestedRef = React.useRef<string | null>(null);

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

  const groupedMessages = React.useMemo(() => groupToolExecutionMessages(messages), [messages]);

  const visibleMessages = React.useMemo(
    () => groupedMessages.filter((message) => {
      if (hasVisibleContent(message.content)) return true;
      return (message.role === "toolResult" || message.role === "tool") && message.toolInput !== undefined;
    }),
    [groupedMessages],
  );

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = React.useState(true);

  const rowVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 10,
  });

  const updateNearBottomState = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(distanceFromBottom < 80);
  }, []);

  const scrollToBottom = React.useCallback((behavior: "auto" | "smooth" = "auto") => {
    const el = scrollRef.current;
    if (!el) return;

    // Prefer virtualizer alignment to avoid off-by-one issues with dynamic row heights.
    if (visibleMessages.length > 0) {
      rowVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: "end", behavior });
      return;
    }

    el.scrollTo({ top: el.scrollHeight, behavior });
  }, [rowVirtualizer, visibleMessages.length]);

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
  }, [visibleMessages.length, isNearBottom, scrollToBottom, updateNearBottomState]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          {/* Active pulse indicator */}
          {sessionId && (
            <span
              className={cn(
                "inline-block h-2 w-2 rounded-full flex-shrink-0 transition-colors",
                agentActive
                  ? "bg-green-400 shadow-[0_0_6px_#4ade8080] animate-pulse"
                  : lastHeartbeatAt
                    ? "bg-slate-400"
                    : "bg-slate-600",
              )}
              title={agentActive ? "Agent active" : lastHeartbeatAt ? "Agent idle" : "No heartbeat yet"}
            />
          )}
          <div className="min-w-0">
            <p className="text-[0.65rem] uppercase tracking-widest text-muted-foreground leading-none mb-0.5">
              {sessionId ? (agentActive ? "Active" : viewerStatus ?? "Connected") : "Session Viewer"}
            </p>
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-medium truncate leading-none flex-1 min-w-0">
                {sessionId ? (sessionName || `Session ${sessionId.slice(0, 8)}…`) : "No session selected"}
              </p>
              {sessionId && activeModel?.provider && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[0.65rem] text-muted-foreground flex-shrink-0"
                  title={`${activeModel.provider} · ${activeModel.name ?? activeModel.id}`}
                >
                  <ProviderIcon provider={activeModel.provider} className="size-3" />
                  <span className="max-w-32 truncate">{activeModel.provider}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Token usage + effort badges */}
        {sessionId && (
          <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
            <HeartbeatStaleBadge lastHeartbeatAt={lastHeartbeatAt} />
            {activeModel?.reasoning && (
              <button
                className="rounded-full border border-border bg-muted px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide hover:bg-muted/80 transition-colors cursor-pointer"
                onClick={() => {
                  if (onExec) {
                    onExec({ type: "exec", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, command: "cycle_thinking_level" });
                  }
                }}
                title="Click to cycle effort level"
                type="button"
              >
                {effortLevel && effortLevel !== "off" ? effortLevel : "effort: off"}
              </button>
            )}
            {tokenUsage && (tokenUsage.input > 0 || tokenUsage.output > 0) && (
              <span
                className="text-[0.7rem] text-muted-foreground tabular-nums"
                title={`Input: ${tokenUsage.input.toLocaleString()} tokens\nOutput: ${tokenUsage.output.toLocaleString()} tokens${tokenUsage.cacheRead ? `\nCache read: ${tokenUsage.cacheRead.toLocaleString()}` : ""}${tokenUsage.cacheWrite ? `\nCache write: ${tokenUsage.cacheWrite.toLocaleString()}` : ""}${tokenUsage.cost ? `\nCost: $${tokenUsage.cost.toFixed(4)}` : ""}`}
              >
                ↑{formatTokenCount(tokenUsage.input)} ↓{formatTokenCount(tokenUsage.output)}
                {tokenUsage.cost > 0 && ` · $${tokenUsage.cost.toFixed(3)}`}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        {!sessionId ? (
          <ConversationEmptyState
            icon={<MessageSquare className="size-8" />}
            title="No session selected"
            description="Pick a session from the sidebar."
          />
        ) : visibleMessages.length === 0 ? (
          <ConversationEmptyState
            title="Waiting for session events"
            description="Messages will appear here in real time."
          />
        ) : (
          <>
            <div
              ref={scrollRef}
              className="h-full overflow-y-auto"
              onScroll={updateNearBottomState}
            >
              <div
                className="w-full py-2"
                style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const message = visibleMessages[virtualRow.index]!;
                  const isLast = virtualRow.index === visibleMessages.length - 1;

                  return (
                    <div
                      key={message.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="w-full"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <SessionMessageItem
                        message={message}
                        activeToolCalls={activeToolCalls}
                        agentActive={agentActive}
                        isLast={isLast}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {!isNearBottom && (
              <Button
                className="absolute bottom-4 left-[50%] -translate-x-1/2 rounded-full"
                onClick={() => scrollToBottom("smooth")}
                size="icon"
                type="button"
                variant="outline"
              >
                <ArrowDownIcon className="size-4" />
              </Button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border px-3 py-2 pp-safe-bottom">
        {pendingQuestion && sessionId && (
          <div className="mb-2 rounded-md border border-amber-400/50 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
            <span className="font-semibold">AskUserQuestion:</span> {pendingQuestion.question}
            {pendingQuestion.options && pendingQuestion.options.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {pendingQuestion.options.map((option) => (
                  <Button
                    key={option}
                    variant="outline"
                    size="sm"
                    className="h-7 border-amber-400/30 bg-background/20 text-amber-100 hover:bg-amber-400/20 hover:text-white"
                    onClick={() => {
                      if (onSendInput) {
                        onSendInput(option);
                        setInput("");
                      }
                    }}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {sessionId && commandOpen && (
          <div className="mb-2 rounded-md border border-border bg-popover text-popover-foreground shadow-sm">
            <Command
              value={isResumeMode ? resumeQuery : commandQuery}
              onValueChange={(v) => setCommandQuery(v)}
              className="w-full"
            >
              <CommandList className="max-h-56">
                {isResumeMode ? (
                  <>
                    <CommandEmpty>{resumeSessionsLoading ? "Loading sessions…" : "No sessions found"}</CommandEmpty>
                    <CommandGroup heading="Resume session">
                      {resumeCandidates.map((session) => (
                        <CommandItem
                          key={session.path}
                          value={`${session.name ?? ""} ${session.id} ${session.path} ${session.firstMessage ?? ""}`}
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
                            <span className="text-[11px] text-muted-foreground truncate">{session.path}</span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                ) : (
                  <>
                    <CommandEmpty>No commands</CommandEmpty>
                    <CommandGroup heading="Commands">
                      {commandSuggestions.map((cmd) => (
                        <CommandItem
                          key={cmd.name}
                          value={cmd.name}
                          onSelect={() => {
                            setInput(`/${cmd.name} `);
                            setCommandQuery("");
                            setCommandOpen(cmd.name === "resume");
                          }}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="font-mono text-sm">/{cmd.name}</span>
                            {cmd.description && <span className="text-xs text-muted-foreground">{cmd.description}</span>}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
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
          onError={(err) => {
            setComposerError(err.message);
          }}
        >
          <ComposerAttachments />
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setComposerError(null);
                setInput(next);
                const trimmed = next.trimStart();
                if (trimmed.startsWith("/")) {
                  setCommandOpen(true);
                  setCommandQuery(trimmed.slice(1));
                } else {
                  setCommandOpen(false);
                  setCommandQuery("");
                }
              }}
              onKeyDown={(event) => {
                if (!sessionId) return;

                // If we're in slash mode, show suggestions + allow selecting with Enter.
                if (commandOpen) {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setCommandOpen(false);
                    return;
                  }

                  // Tab: autocomplete the first matching command and close the popover
                  if (event.key === "Tab" && commandSuggestions.length > 0) {
                    event.preventDefault();
                    const first = commandSuggestions[0]!;
                    setInput(`/${first.name} `);
                    setCommandQuery("");
                    setCommandOpen(first.name === "resume");
                    return;
                  }

                  // If the user presses Enter, we either execute the selected command
                  // (cmdk handles selection) or fall back to the manual parser below.
                }

                // Minimal slash-command exec for supported commands.
                if (event.key !== "Enter" || event.shiftKey) return;

                const trimmed = input.trim();
                if (!trimmed.startsWith("/")) return;

                if (executeSlashCommand(trimmed)) {
                  event.preventDefault();
                  return;
                }
              }}
              disabled={!sessionId}
              placeholder={
                sessionId
                  ? pendingQuestion
                    ? `Answer: ${pendingQuestion.question}`
                    : availableCommands && availableCommands.length > 0
                      ? `Send a message… (try /${availableCommands[0]!.name})`
                      : "Send a message to this session…"
                  : "Pick a session to chat"
              }
              className="min-h-12 max-h-36"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <ComposerAttachmentButton />
              <span className="px-2 text-xs text-muted-foreground">
                {sessionId
                  ? pendingQuestion
                    ? "Provide the answer and press Enter"
                    : "Press Enter to send"
                  : "Select a session to send messages"}
              </span>
            </PromptInputTools>
            <ComposerSubmitButton
              sessionId={sessionId}
              input={input}
              agentActive={agentActive}
              onExec={onExec}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
