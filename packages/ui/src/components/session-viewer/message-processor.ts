import * as React from "react";
import type { RelayMessage } from "./types";
import { groupToolExecutionMessages, groupSubAgentConversations, groupPluginResults } from "./grouping";
import { hasVisibleContent } from "./utils";

const PAGE_SIZE = 50;
const GROUP_LOOKBEHIND = 20;

export interface MessageProcessorResult {
  visibleMessages: RelayMessage[];
  renderedMessages: RelayMessage[];
  hasMore: boolean;
  loadMoreMessages: () => void;
}

function isVisibleMessage(message: RelayMessage): boolean {
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
}

function processMessages(messages: RelayMessage[]): RelayMessage[] {
  return groupPluginResults(groupSubAgentConversations(groupToolExecutionMessages(messages))).filter(isVisibleMessage);
}

function hasVisibleBefore(messages: RelayMessage[], end: number): boolean {
  for (let i = 0; i < end; i += 1) {
    if (isVisibleMessage(messages[i]!)) return true;
  }
  return false;
}

/**
 * Builds only the tail window needed by the transcript. Export/copy actions use
 * the raw session messages so normal renders don't group/sort/filter every old
 * message in large sessions.
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

  const { visibleMessages, hasMore } = React.useMemo(() => {
    let start = Math.max(0, messages.length - renderedCount);
    let processed: RelayMessage[] = [];
    let lookbehindStart = start;

    while (true) {
      lookbehindStart = Math.max(0, start - GROUP_LOOKBEHIND);
      processed = processMessages(messages.slice(lookbehindStart));
      if (processed.length >= renderedCount || lookbehindStart === 0) break;
      start = Math.max(0, start - PAGE_SIZE);
    }

    const rendered = processed.slice(-renderedCount);
    const hasOlderVisible =
      processed.length > rendered.length ||
      (lookbehindStart > 0 && hasVisibleBefore(messages, lookbehindStart));

    return { visibleMessages: rendered, hasMore: hasOlderVisible };
  }, [messages, renderedCount]);

  const loadMoreMessages = React.useCallback(() => {
    setRenderedCount((c) => c + PAGE_SIZE);
  }, []);

  return {
    visibleMessages,
    renderedMessages: visibleMessages,
    hasMore,
    loadMoreMessages,
  };
}
