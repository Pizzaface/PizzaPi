import * as React from "react";
import type { RelayMessage } from "./types";
import {
  groupToolExecutionMessages,
  groupSubAgentConversations,
  groupPluginResults,
  isPluginResult,
} from "./grouping";
import { hasVisibleContent } from "./utils";

const PAGE_SIZE = 50;

export interface MessageProcessorResult {
  visibleMessages: RelayMessage[];
  hasMore: boolean;
  loadMoreMessages: () => void;
}

export function isVisibleMessage(message: RelayMessage): boolean {
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

function timestampSort(messages: RelayMessage[]): RelayMessage[] {
  return messages.slice().sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity));
}

export function getExportMessages(messages: RelayMessage[]): RelayMessage[] {
  return timestampSort(groupMessages(messages));
}

function isSubAgentToolMessage(message: RelayMessage): boolean {
  return (message.role === "tool" || message.role === "toolResult") &&
    /(?:^|\.)(send_message|wait_for_message|check_messages)$/i.test(message.toolName ?? "");
}

/** True when some grouped tool-execution item is still waiting on its result. */
function hasOpenToolCall(stage1: RelayMessage[]): boolean {
  return stage1.some((m) => (m.role === "tool" || m.role === "toolResult") && m.content === null);
}

/** True when stage1's trailing item is mid a send_message/wait_for_message/check_messages run
 *  that groupSubAgentConversations would still extend if more such items follow. */
function hasOpenSubAgentRun(stage1: RelayMessage[]): boolean {
  const last = stage1[stage1.length - 1];
  return last !== undefined && isSubAgentToolMessage(last);
}

/** True when stage3's trailing plugin-result run hasn't been closed by a visible
 *  or tool/toolResult message yet, matching groupPluginResults' own close condition. */
function hasOpenPluginRun(stage3: RelayMessage[]): boolean {
  for (let i = stage3.length - 1; i >= 0; i--) {
    const m = stage3[i]!;
    if (isPluginResult(m)) return true;
    if (hasVisibleContent(m.content) || m.role === "tool" || m.role === "toolResult") return false;
  }
  return false;
}

interface ProcessedCache {
  /** The raw messages array this cache was built from (by reference). */
  raw: RelayMessage[];
  /** Number of leading raw messages whose grouped form can never change again,
   *  no matter what gets appended after them (see incrementalGroup below). */
  settledRawCount: number;
  /** groupMessages(raw.slice(0, settledRawCount)) — reused verbatim across calls. */
  settledGrouped: RelayMessage[];
}

/**
 * Groups the full raw transcript, reusing the previous call's work for the
 * leading portion of `raw` that hasn't changed. Transcripts mostly append, so
 * once a prefix settles (no dangling tool call, sub-agent run or plugin run,
 * and its last message is finalized) it never needs regrouping — only the
 * live tail does. Any divergence from a pure append (edit, truncation, new
 * session) is detected by reference comparison and falls back to a full
 * regroup, so correctness never depends on the cache being right, only speed
 * does. The result is byte-for-byte identical to `groupMessages(raw)`.
 */
function incrementalGroup(raw: RelayMessage[], cache: ProcessedCache | null): {
  grouped: RelayMessage[];
  cache: ProcessedCache;
} {
  let start = 0;
  let settledGrouped: RelayMessage[] = [];

  if (cache && raw.length >= cache.settledRawCount) {
    let prefixMatches = true;
    for (let i = 0; i < cache.settledRawCount; i++) {
      if (raw[i] !== cache.raw[i]) {
        prefixMatches = false;
        break;
      }
    }
    if (prefixMatches) {
      start = cache.settledRawCount;
      settledGrouped = cache.settledGrouped;
    }
  }

  const tail = start === 0 ? raw : raw.slice(start);
  const tailStage1 = groupToolExecutionMessages(tail);
  const tailStage2 = groupSubAgentConversations(tailStage1);
  const tailStage3 = groupPluginResults(tailStage2);
  const grouped = settledGrouped.length > 0 ? settledGrouped.concat(tailStage3) : tailStage3;

  const lastMessage = raw[raw.length - 1];
  const tailClosed =
    raw.length > start &&
    lastMessage?.timestamp !== undefined &&
    !hasOpenToolCall(tailStage1) &&
    !hasOpenSubAgentRun(tailStage1) &&
    !hasOpenPluginRun(tailStage3);

  return {
    grouped,
    cache: tailClosed
      ? { raw, settledRawCount: raw.length, settledGrouped: grouped }
      : { raw, settledRawCount: start, settledGrouped },
  };
}

/**
 * Builds the visible transcript tail. Grouping/sorting/filtering runs over the
 * full message list (incrementally cached — see incrementalGroup), so the
 * visible tail and item keys always match what processing the whole transcript
 * from scratch would produce. Only the final render slice is bounded.
 */
export function useMessageProcessor(
  messages: RelayMessage[],
  sessionId: string | null,
): MessageProcessorResult {
  const [renderedCount, setRenderedCount] = React.useState(PAGE_SIZE);
  const cacheRef = React.useRef<ProcessedCache | null>(null);

  // Reset the pagination window and incremental cache whenever the session changes.
  React.useEffect(() => {
    setRenderedCount(PAGE_SIZE);
    cacheRef.current = null;
  }, [sessionId]);

  const { visibleMessages, hasMore } = React.useMemo(() => {
    const { grouped, cache } = incrementalGroup(messages, cacheRef.current);
    cacheRef.current = cache;
    const allVisible = timestampSort(grouped).filter(isVisibleMessage);
    const rendered = allVisible.slice(-renderedCount);
    return { visibleMessages: rendered, hasMore: allVisible.length > rendered.length };
  }, [messages, renderedCount]);

  const loadMoreMessages = React.useCallback(() => {
    setRenderedCount((c) => c + PAGE_SIZE);
  }, []);

  return { visibleMessages, hasMore, loadMoreMessages };
}
