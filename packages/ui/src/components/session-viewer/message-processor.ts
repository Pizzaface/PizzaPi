import * as React from "react";
import type { RelayMessage } from "./types";
import { groupToolExecutionMessages, groupSubAgentConversations, groupPluginResults } from "./grouping";
import { hasVisibleContent } from "./utils";

const PAGE_SIZE = 50;
const GROUP_LOOKBEHIND = 20;

export interface MessageProcessorResult {
  visibleMessages: RelayMessage[];
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

function groupMessages(messages: RelayMessage[]): RelayMessage[] {
  return groupPluginResults(groupSubAgentConversations(groupToolExecutionMessages(messages)));
}

function processMessages(messages: RelayMessage[]): RelayMessage[] {
  return groupMessages(messages).filter(isVisibleMessage);
}

function timestampSort(messages: RelayMessage[]): RelayMessage[] {
  return messages.slice().sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity));
}

export function getExportMessages(messages: RelayMessage[]): RelayMessage[] {
  return timestampSort(groupMessages(messages));
}

function toolCallId(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return;
  const value = block as Record<string, unknown>;
  return value.type === "toolCall" && typeof (value.id ?? value.toolCallId) === "string"
    ? String(value.id ?? value.toolCallId)
    : undefined;
}

// Extend a raw window to include call origins that grouping needs, and keep a
// contiguous sub-agent run intact when the window starts in its middle.
function safeWindowStart(messages: RelayMessage[], start: number): number {
  let safeStart = start;
  const ids = new Set<string>();
  let hasUnkeyedToolResult = false;
  for (const message of messages.slice(start)) {
    if (message.role !== "tool" && message.role !== "toolResult") continue;
    if (message.toolCallId) ids.add(message.toolCallId);
    else if (message.role === "toolResult") hasUnkeyedToolResult = true;
  }
  if (ids.size || hasUnkeyedToolResult) {
    for (let i = 0; i < start; i += 1) {
      const message = messages[i]!;
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      if (message.content.some((block) => {
        const id = toolCallId(block);
        return id !== undefined && (hasUnkeyedToolResult || ids.has(id));
      })) {
        safeStart = Math.min(safeStart, i);
        if (hasUnkeyedToolResult) break;
        // Keep scanning: more than one call in the window can originate earlier.
      }
    }
  }
  while (safeStart > 0 && isSubAgentToolMessage(messages[safeStart - 1]!)) safeStart -= 1;
  return safeStart;
}

function isSubAgentToolMessage(message: RelayMessage): boolean {
  return (message.role === "tool" || message.role === "toolResult") &&
    /(?:^|\.)(send_message|wait_for_message|check_messages)$/i.test(message.toolName ?? "");
}

function hasVisibleBefore(messages: RelayMessage[], end: number): boolean {
  for (let i = 0; i < end; i += 1) {
    if (isVisibleMessage(messages[i]!)) return true;
  }
  return false;
}

/**
 * Builds a bounded tail window for the transcript. Export grouping is deferred
 * until the user requests a copy or download.
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
    let lookbehindStart = start;
    let processed: RelayMessage[] = [];

    while (true) {
      lookbehindStart = safeWindowStart(messages, Math.max(0, start - GROUP_LOOKBEHIND));
      processed = timestampSort(processMessages(messages.slice(lookbehindStart)));
      if (processed.length >= renderedCount || lookbehindStart === 0) break;
      start = Math.max(0, start - PAGE_SIZE);
    }

    const rendered = processed.slice(-renderedCount);
    const hasOlderVisible = processed.length > rendered.length ||
      (lookbehindStart > 0 && hasVisibleBefore(messages, lookbehindStart));
    return { visibleMessages: rendered, hasMore: hasOlderVisible };
  }, [messages, renderedCount]);

  const loadMoreMessages = React.useCallback(() => {
    setRenderedCount((c) => c + PAGE_SIZE);
  }, []);

  return { visibleMessages, hasMore, loadMoreMessages };
}
