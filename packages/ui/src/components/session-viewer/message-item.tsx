import * as React from "react";
import { AlertTriangleIcon, Loader2 } from "lucide-react";
import type { RelayMessage } from "./types";
import {
  renderContent,
  roleLabel,
  toMessageRole,
  CompactionSummaryCard,
  CommandResultCard,
  isCommandResult,
} from "./rendering";
import { normalizeToolName } from "./utils";
import { isTriggerMessage, renderTriggerCard } from "./cards/InterAgentCards";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { MessageCopyButton } from "@/components/ai-elements/conversation";
import { exportToMarkdown } from "@/lib/export-markdown";
import { cn } from "@/lib/utils";
import { useConversationScrollRef } from "@/components/ai-elements/conversation";

// ── SessionMessageItem ───────────────────────────────────────────────────────

interface SessionMessageItemProps {
  message: RelayMessage;
  activeToolCalls?: Map<string, string>;
  agentActive?: boolean;
  isLast: boolean;
  onTriggerResponse?: (
    triggerId: string,
    response: string,
    action?: string,
    sourceSessionId?: string,
  ) => boolean | void | Promise<boolean>;
  onActionSigilResponse?: (text: string) => Promise<boolean>;
}

/**
 * Renders a single conversation message, choosing the appropriate card variant
 * based on the message role and content type.
 *
 * Memoized: only re-renders when the message object, `isLast` status,
 * `agentActive`, `activeToolCalls` map reference, or `onTriggerResponse` change.
 */
export const SessionMessageItem = React.memo(
  ({
    message,
    activeToolCalls,
    agentActive,
    isLast,
    onTriggerResponse,
    onActionSigilResponse,
  }: SessionMessageItemProps) => {
    // System messages with structured command result data → standalone card
    if (message.role === "system" && isCommandResult(message.content)) {
      return (
        <div className="w-full px-4 py-1.5 max-w-3xl mx-auto">
          <CommandResultCard data={message.content} />
        </div>
      );
    }

    // Compaction/branch summary cards → standalone element, no message wrapper
    if (
      (message.role === "compactionSummary" || message.role === "branchSummary") &&
      message.summary
    ) {
      return (
        <div className="w-full px-4 py-1.5 max-w-3xl mx-auto">
          <CompactionSummaryCard summary={message.summary} tokensBefore={message.tokensBefore} />
        </div>
      );
    }

    // Chromeless tool cards (toggle_plan_mode) → standalone, no "TOOL · NAME" wrapper
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
              onTriggerResponse,
              onActionSigilResponse,
            )}
          </div>
        );
      }
    }

    // Sub-agent conversation cards → no outer message wrapper (own full-width styling)
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
            onTriggerResponse,
            onActionSigilResponse,
          )}
        </div>
      );
    }

    // Trigger-injected user messages → TriggerCard instead of blue bubble
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      isTriggerMessage(message.content)
    ) {
      return (
        <div className="w-full max-w-3xl mx-auto px-4 py-1.5">
          {renderTriggerCard(message.content, onTriggerResponse)}
        </div>
      );
    }

    return (
      <div className="group/msg w-full px-4 py-1.5">
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
              {message.timestamp && (
                <span>• {new Date(message.timestamp).toLocaleTimeString()}</span>
              )}
              {message.isError && <span className="text-destructive">• Error</span>}
              <MessageCopyButton
                text={exportToMarkdown([message])}
                className="ml-auto opacity-0 group-hover/msg:opacity-100 transition-opacity"
              />
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
              agentActive && isLast && message.timestamp === undefined,
              message.thinking,
              message.thinkingDuration,
              undefined, // subAgentTurns
              message.details,
              onTriggerResponse,
              onActionSigilResponse,
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
  },
  (prev, next) => {
    if (prev.message !== next.message) return false;
    if (prev.isLast !== next.isLast) return false;
    if ((prev.isLast || next.isLast) && prev.agentActive !== next.agentActive) return false;
    if (prev.activeToolCalls !== next.activeToolCalls) return false;
    if (prev.onTriggerResponse !== next.onTriggerResponse) return false;
    if (prev.onActionSigilResponse !== next.onActionSigilResponse) return false;
    return true;
  },
);

SessionMessageItem.displayName = "SessionMessageItem";

// ── PaginationSentinel ───────────────────────────────────────────────────────

interface PaginationSentinelProps {
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
}

/**
 * Renders a 1px sentinel at the top of the message list and uses an
 * IntersectionObserver to trigger `onLoadMore` when the user scrolls up.
 *
 * Must be rendered inside a <Conversation> (StickToBottom) so it can access
 * the real scroll container via useConversationScrollRef(). Remounts on session
 * switch (key={sessionId}) — automatically recreating the observer.
 */
export function PaginationSentinel({ hasMore, onLoadMore, loading = false }: PaginationSentinelProps) {
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = useConversationScrollRef();

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollRef.current;
    if (!sentinel || !scroller || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        onLoadMore();
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore, scrollRef]);

  return (
    <>
      <div ref={sentinelRef} className="h-px" />
      {hasMore && (
        <div className="py-2 text-center text-xs text-muted-foreground">
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Loading earlier messages…
            </span>
          ) : (
            "Scroll up for older messages"
          )}
        </div>
      )}
    </>
  );
}
