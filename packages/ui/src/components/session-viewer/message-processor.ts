import * as React from "react";
import type { RelayMessage } from "./types";
import { groupToolExecutionMessages, groupSubAgentConversations } from "./grouping";
import { hasVisibleContent } from "./utils";

const PAGE_SIZE = 50;

export interface MessageProcessorResult {
  groupedMessages: RelayMessage[];
  sortedMessages: RelayMessage[];
  visibleMessages: RelayMessage[];
  renderedMessages: RelayMessage[];
  hasMore: boolean;
  loadMoreMessages: () => void;
}

/**
 * Memoizes the full message processing pipeline:
 *   raw messages → grouped → sorted → filtered (visible) → paginated (rendered)
 *
 * Also manages the pagination window, resetting it whenever the session changes.
 */
export function useMessageProcessor(
  messages: RelayMessage[],
  sessionId: string | null,
): MessageProcessorResult {
  const [renderedCount, setRenderedCount] = React.useState(PAGE_SIZE);

  // Reset the pagination window whenever the session changes.
  React.useEffect(() => {
    setRenderedCount(PAGE_SIZE);
  }, [sessionId]);

  const groupedMessages = React.useMemo(
    () => groupSubAgentConversations(groupToolExecutionMessages(messages)),
    [messages],
  );

  // Stable insertion-order-preserving sort: messages with timestamps sort
  // chronologically, messages without timestamps (Infinity) go to the end,
  // and messages with the same timestamp keep their original relative order.
  const sortedMessages = React.useMemo(() => {
    return groupedMessages.slice().sort((a, b) => {
      const aTs = a.timestamp ?? Infinity;
      const bTs = b.timestamp ?? Infinity;
      if (aTs !== bTs) return aTs - bTs;
      return 0;
    });
  }, [groupedMessages]);

  const visibleMessages = React.useMemo(
    () =>
      sortedMessages.filter((message) => {
        if (message.role === "subAgentConversation")
          return (message.subAgentTurns?.length ?? 0) > 0;
        if (
          (message.role === "compactionSummary" || message.role === "branchSummary") &&
          message.summary
        )
          return true;
        if (hasVisibleContent(message.content)) return true;
        if (message.stopReason === "error" && message.errorMessage) return true;
        return (
          (message.role === "toolResult" || message.role === "tool") &&
          message.toolInput !== undefined
        );
      }),
    [sortedMessages],
  );

  const renderedMessages = React.useMemo(
    () => visibleMessages.slice(-renderedCount),
    [visibleMessages, renderedCount],
  );

  const hasMore = visibleMessages.length > renderedCount;

  const loadMoreMessages = React.useCallback(() => {
    setRenderedCount((c) => c + PAGE_SIZE);
  }, []);

  return {
    groupedMessages,
    sortedMessages,
    visibleMessages,
    renderedMessages,
    hasMore,
    loadMoreMessages,
  };
}
