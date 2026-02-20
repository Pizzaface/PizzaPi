import * as React from "react";
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
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { ArrowDownIcon, MessageSquare } from "lucide-react";

export type { RelayMessage } from "@/components/session-viewer/types";

export interface SessionViewerProps {
  sessionId: string | null;
  messages: RelayMessage[];
  activeToolCalls?: Map<string, string>;
  pendingQuestion?: string | null;
  availableCommands?: Array<{ name: string; description?: string }>;
  onSendInput?: (text: string) => boolean | void | Promise<boolean | void>;
  onExec?: (payload: unknown) => boolean | void;
}

export function SessionViewer({ sessionId, messages, activeToolCalls, pendingQuestion, availableCommands, onSendInput, onExec }: SessionViewerProps) {
  const [input, setInput] = React.useState("");

  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");

  React.useEffect(() => {
    if (!sessionId) {
      setInput("");
    }
  }, [sessionId]);

  const handleSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text || !sessionId || !onSendInput) return;

      Promise.resolve(onSendInput(text)).then((result) => {
        if (result !== false) setInput("");
      });
    },
    [onSendInput, sessionId],
  );

  const supportedWebCommands = React.useMemo(() => {
    // Only include commands that we actually intercept/execute via exec.
    // (availableCommands contains prompt templates, skills, etc. which we don't exec.)
    return [
      { name: "new", description: "Start a new conversation" },
      { name: "model", description: "Cycle model" },
      { name: "cycle_model", description: "Cycle model" },
      { name: "compact", description: "Compact context" },
      { name: "name", description: "Set session name" },
      { name: "copy", description: "Copy last assistant message" },
    ];
  }, []);

  const commandSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const list = supportedWebCommands;
    if (!query) return list;
    return list.filter((c) => c.name.toLowerCase().includes(query));
  }, [commandQuery, supportedWebCommands]);

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

  const updateNearBottomState = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(distanceFromBottom < 80);
  }, []);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

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
      <div className="border-b border-border px-4 py-2 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Session Viewer</p>
          <p className="text-sm font-medium truncate">
            {sessionId ? `Session ${sessionId}` : "No session selected"}
          </p>
        </div>
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
              <div className="flex flex-col py-2">
                {visibleMessages.map((message) => (
                  <div
                    key={message.key}
                    className="w-full px-4 py-1.5"
                  >
                    <Message from={toMessageRole(message.role)}>
                      <MessageContent
                        className={cn(
                          "max-w-3xl rounded-lg border px-3 py-2",
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
                        )}
                      </MessageContent>
                    </Message>
                  </div>
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
              >
                <ArrowDownIcon className="size-4" />
              </Button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border px-3 py-2">
        {pendingQuestion && sessionId && (
          <div className="mb-2 rounded-md border border-amber-400/50 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
            <span className="font-semibold">AskUserQuestion:</span> {pendingQuestion}
          </div>
        )}

        {sessionId && commandOpen && (
          <div className="mb-2 rounded-md border border-border bg-popover text-popover-foreground shadow-sm">
            <Command
              value={commandQuery}
              onValueChange={(v) => setCommandQuery(v)}
              className="w-full"
            >
              <CommandList className="max-h-48">
                <CommandEmpty>No commands</CommandEmpty>
                <CommandGroup heading="Commands">
                  {commandSuggestions.map((cmd) => (
                    <CommandItem
                      key={cmd.name}
                      value={cmd.name}
                      onSelect={() => {
                        setInput(`/${cmd.name} `);
                        setCommandQuery("");
                        setCommandOpen(false);
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="font-mono text-sm">/{cmd.name}</span>
                        {cmd.description && <span className="text-xs text-muted-foreground">{cmd.description}</span>}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        )}

        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(event) => {
                const next = event.currentTarget.value;
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
                    setCommandOpen(false);
                    return;
                  }

                  // If the user presses Enter, we either execute the selected command
                  // (cmdk handles selection) or fall back to the manual parser below.
                }

                // Minimal slash-command exec for supported commands.
                if (event.key !== "Enter" || event.shiftKey) return;

                const trimmed = input.trim();
                if (!trimmed.startsWith("/")) return;

                const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
                const args = rest.join(" ");
                const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

                if (rawCommand === "new") {
                  event.preventDefault();
                  if (onExec) {
                    onExec({ type: "exec", id, command: "new_session" });
                  } else if (onSendInput) {
                    // Fallback: older runners/websocket paths may not support exec.
                    // Sending "/new" as a normal input at least triggers the built-in command.
                    void onSendInput("/new");
                  }
                  setInput("");
                  setCommandOpen(false);
                  return;
                }

                if (!onExec) return;

                if (rawCommand === "model" || rawCommand === "cycle_model") {
                  event.preventDefault();
                  onExec({ type: "exec", id, command: "cycle_model" });
                  setInput("");
                  setCommandOpen(false);
                  return;
                }

                if (rawCommand === "compact") {
                  event.preventDefault();
                  onExec({ type: "exec", id, command: "compact", customInstructions: args || undefined });
                  setInput("");
                  setCommandOpen(false);
                  return;
                }

                if (rawCommand === "name") {
                  event.preventDefault();
                  onExec({ type: "exec", id, command: "set_session_name", name: args });
                  setInput("");
                  setCommandOpen(false);
                  return;
                }

                if (rawCommand === "copy") {
                  event.preventDefault();
                  onExec({ type: "exec", id, command: "get_last_assistant_text" });
                  setInput("");
                  setCommandOpen(false);
                  return;
                }
              }}
              disabled={!sessionId}
              placeholder={
                sessionId
                  ? pendingQuestion
                    ? `Answer: ${pendingQuestion}`
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
              <span className="px-2 text-xs text-muted-foreground">
                {sessionId
                  ? pendingQuestion
                    ? "Provide the answer and press Enter"
                    : "Press Enter to send"
                  : "Select a session to send messages"}
              </span>
            </PromptInputTools>
            <PromptInputSubmit status="ready" disabled={!sessionId || !input.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
