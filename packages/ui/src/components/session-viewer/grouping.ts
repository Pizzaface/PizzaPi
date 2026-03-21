import type { RelayMessage, SubAgentTurn } from "./types";

import {
  hasVisibleContent,
  normalizeToolName,
  extractTextFromToolContent,
} from "./utils";

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

type PendingThinking = { thinking: string; duration: number };

function parseToolArguments(argumentsValue: unknown): unknown {
  if (argumentsValue && typeof argumentsValue === "object") {
    return argumentsValue;
  }

  if (typeof argumentsValue === "string") {
    try {
      return JSON.parse(argumentsValue) as unknown;
    } catch {
      // Incomplete / malformed JSON (e.g. stream truncation) — return an empty
      // object rather than the raw string so downstream code always gets an
      // object-shaped toolInput, consistent with rendering.tsx's own fallback.
      return {};
    }
  }

  return {};
}

/**
 * Tool calls we want to render as *grouped tool execution cards* rather than as inline
 * <Tool /> blocks inside the assistant message.
 */
/**
 * All tool calls are grouped with their results so they render as standalone
 * cards in the conversation flow rather than inline in assistant messages.
 * Custom rendering for specific tools (bash, read, edit, write, etc.) is
 * handled in renderGroupedToolExecution; everything else gets a generic card.
 */
function shouldGroupToolCall(_toolName: string): boolean {
  return true;
}

/**
 * Extract all toolCallIds referenced in a grouped-tool toolCall block within an
 * assistant message's content array.
 */
function extractGroupedToolCallIds(message: RelayMessage): Set<string> {
  const ids = new Set<string>();
  if (message.role !== "assistant" || !Array.isArray(message.content)) return ids;
  for (const pending of extractGroupedPendingToolCalls(message)) {
    if (pending.toolCallId) ids.add(pending.toolCallId);
  }
  return ids;
}

function extractGroupedPendingToolCalls(message: RelayMessage): PendingToolCall[] {
  const pending: PendingToolCall[] = [];
  if (message.role !== "assistant" || !Array.isArray(message.content)) return pending;

  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall") continue;

    const toolName = typeof b.name === "string" ? b.name : "unknown";
    if (!shouldGroupToolCall(toolName)) continue;

    const toolCallId =
      typeof b.toolCallId === "string"
        ? b.toolCallId
        : typeof b.id === "string"
          ? b.id
          : "";

    pending.push({
      toolCallId,
      toolName,
      args: parseToolArguments(b.arguments),
    });
  }

  return pending;
}

function collectToolCallIdsWithResult(messages: RelayMessage[]): Set<string> {
  const toolCallIdsWithResult = new Set<string>();
  const pendingToolCalls: PendingToolCall[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      pendingToolCalls.push(...extractGroupedPendingToolCalls(message));
      continue;
    }

    if (message.role !== "toolResult" && message.role !== "tool") continue;

    let matchedPendingIndex = -1;

    if (message.toolCallId) {
      matchedPendingIndex = pendingToolCalls.findIndex(
        (pending) => pending.toolCallId && pending.toolCallId === message.toolCallId
      );
    }

    if (matchedPendingIndex < 0) {
      const normalizedName = normalizeToolName(message.toolName);
      matchedPendingIndex = pendingToolCalls.findIndex(
        (pending) => normalizeToolName(pending.toolName) === normalizedName
      );
    }

    if (matchedPendingIndex < 0 && pendingToolCalls.length > 0) {
      matchedPendingIndex = 0;
    }

    const matched =
      matchedPendingIndex >= 0
        ? pendingToolCalls.splice(matchedPendingIndex, 1)[0]
        : undefined;
    const matchedToolCallId = message.toolCallId ?? matched?.toolCallId;

    if (matchedToolCallId) {
      toolCallIdsWithResult.add(matchedToolCallId);
    }
  }

  return toolCallIdsWithResult;
}

/**
 * When the same assistant turn is represented multiple times in the message list
 * (e.g. a streaming partial saved alongside the final message), drop all earlier
 * copies so only the last (most complete) version gets split into grouped items.
 *
 * Two assistant messages are considered duplicates of the same turn when they
 * share at least one grouped-tool toolCallId.
 *
 * If a non-errored version and an errored version both reference the same
 * toolCallId, we prefer the non-errored one.  This avoids propagating
 * stopReason="error" / errorMessage onto the content parts that are split off
 * during grouping — which would otherwise show a spurious ERROR badge on the
 * assistant text bubble even though the tool completed successfully.
 */
function deduplicateAssistantMessages(messages: RelayMessage[]): RelayMessage[] {
  // Build two maps:
  //   toolCallId → last index of ANY assistant message that references it
  //   toolCallId → last index of a NON-ERRORED assistant message that references it
  const lastIndexForToolCallId = new Map<string, number>();
  const lastNonErroredIndexForToolCallId = new Map<string, number>();
  // Cache the extracted IDs for each message index to avoid re-parsing the content during the filter pass.
  const messageIdsMap = new Map<number, Set<string>>();
  const assistantIndexes: number[] = [];

  // Pre-collect tool call IDs that have a corresponding tool result in the
  // transcript, including legacy toolResult messages that only match back to a
  // pending tool call by tool name / order.
  const toolCallIdsWithResult = collectToolCallIdsWithResult(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const ids = extractGroupedToolCallIds(msg);
    if (ids.size === 0) continue;

    assistantIndexes.push(i);
    messageIdsMap.set(i, ids);

    for (const id of ids) {
      lastIndexForToolCallId.set(id, i);
      // Only record the non-errored index when a tool result exists for this
      // ID.  If no result ever arrives the errored snapshot is the right one
      // to surface (it carries the failure state); recording a non-errored
      // partial here would cause the filter below to prefer the partial and
      // silently drop the error banner.
      if (msg.stopReason !== "error" && toolCallIdsWithResult.has(id)) {
        lastNonErroredIndexForToolCallId.set(id, i);
      }
    }
  }

  if (lastIndexForToolCallId.size === 0) return messages;

  // Assistant snapshots that share toolCallIds represent alternate versions of
  // the same turn.  When a later snapshot drops one of the earlier IDs, that
  // dropped ID is stale and should not keep the earlier partial alive.
  const componentValidIdsByMessageIndex = new Map<number, Set<string>>();
  const visitedAssistantIndexes = new Set<number>();

  for (const startIndex of assistantIndexes) {
    if (visitedAssistantIndexes.has(startIndex)) continue;

    const queue = [startIndex];
    const component: number[] = [];
    visitedAssistantIndexes.add(startIndex);

    while (queue.length > 0) {
      const currentIndex = queue.shift()!;
      component.push(currentIndex);
      const currentIds = messageIdsMap.get(currentIndex)!;

      for (const candidateIndex of assistantIndexes) {
        if (visitedAssistantIndexes.has(candidateIndex)) continue;
        const candidateIds = messageIdsMap.get(candidateIndex)!;
        const overlaps = [...candidateIds].some((id) => currentIds.has(id));
        if (!overlaps) continue;
        visitedAssistantIndexes.add(candidateIndex);
        queue.push(candidateIndex);
      }
    }

    const latestIndex = Math.max(...component);
    const validIds = new Set(messageIdsMap.get(latestIndex)!);
    for (const index of component) {
      componentValidIdsByMessageIndex.set(index, validIds);
    }
  }

  // For each assistant message, determine the "preferred" index for each of
  // its still-relevant tool call IDs:
  //   - If a non-errored version exists for this ID AND a tool result arrived,
  //     prefer the last non-errored version (avoids a spurious error badge on
  //     a successfully-completed tool).
  //   - Otherwise fall back to the last version overall (errored or not) so
  //     that the failure state is visible when no result ever arrived.
  //
  // A message is kept when it is the preferred version for at least one ID that
  // still appears in the latest snapshot of its turn. This preserves newer IDs
  // introduced by later snapshots while dropping stale partial-only IDs that a
  // later snapshot removed.
  return messages.filter((msg, i) => {
    if (msg.role !== "assistant") return true;

    const ids = messageIdsMap.get(i);
    if (!ids || ids.size === 0) return true;

    const validIds = componentValidIdsByMessageIndex.get(i) ?? ids;
    for (const id of ids) {
      if (!validIds.has(id)) continue;
      const preferredIdx = lastNonErroredIndexForToolCallId.has(id)
        ? lastNonErroredIndexForToolCallId.get(id)!
        : lastIndexForToolCallId.get(id)!;
      if (preferredIdx === i) return true;
    }
    return false;
  });
}

function getThinkingContent(buf: unknown[]): { thinking: string; duration: number } | null {
  let thinking = "";
  let duration = 0;
  let hasThinking = false;

  for (const block of buf) {
    if (!block || typeof block !== "object") return null;
    const b = block as Record<string, unknown>;

    if (b.type === "thinking") {
      hasThinking = true;
      const text = typeof b.thinking === "string" ? b.thinking : "";
      if (text) thinking += (thinking ? "\n" : "") + text;
      if (typeof b.durationSeconds === "number") duration += b.durationSeconds;
    } else if (b.type === "text") {
      const text = typeof b.text === "string" ? b.text : "";
      // If there is any visible text, it's not a pure thinking block
      if (text.trim()) return null;
    } else {
      // Any other block type (e.g. image) means it's not pure thinking
      return null;
    }
  }

  return hasThinking ? { thinking, duration } : null;
}

export function groupToolExecutionMessages(messages: RelayMessage[]): RelayMessage[] {
  // Pre-deduplicate: drop earlier copies of the same assistant turn (streaming
  // partials) so their split-off thinking blocks don't appear below the tool card
  // produced by the final (timestamped) version.
  const deduped = deduplicateAssistantMessages(messages);

  // Map from tool item key → index in `grouped`.
  const toolCallIndexByKey = new Map<string, number>();
  // Map from toolCallId → index in `grouped`.
  const toolCallIndexByCallId = new Map<string, number>();

  // Fallback list for matching toolResult messages when toolCallId is absent.
  const pendingToolCalls: PendingToolCall[] = [];

  const grouped: RelayMessage[] = [];

  for (const message of deduped) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const blocks = message.content as unknown[];

      let assistantPartIndex = 0;
      let toolCallOrdinal = 0;
      let buffer: unknown[] = [];
      let pendingThinking: PendingThinking | null = null;

      const pushAssistantPart = (isBeforeTool: boolean) => {
        if (!hasVisibleContent(buffer)) {
          buffer = [];
          return;
        }

        // If we are immediately followed by a tool, and the buffer is PURELY thinking,
        // steal the thinking content to attach to the tool card.
        if (isBeforeTool) {
          const thought = getThinkingContent(buffer);
          if (thought) {
            pendingThinking = thought;
            buffer = [];
            return;
          }
        }

        grouped.push({
          ...message,
          key: `${message.key}:assistant:${assistantPartIndex++}`,
          content: buffer,
        });
        buffer = [];
        pendingThinking = null;
      };

      for (const block of blocks) {
        if (!block || typeof block !== "object") {
          buffer.push(block);
          continue;
        }

        const b = block as Record<string, unknown>;

        if (b.type === "toolCall") {
          const toolName = typeof b.name === "string" ? b.name : "unknown";

          // Only group the tools we have custom rendering for (bash/read/edit).
          // Other toolCalls remain inline in the assistant message.
          if (!shouldGroupToolCall(toolName)) {
            buffer.push(block);
            continue;
          }

          // Flush any assistant text/thinking blocks before the tool call so the
          // tool card appears *after* the assistant content that triggered it.
          pushAssistantPart(true);

          // ToolCall blocks use `id` (not `toolCallId`) per pi-ai types, but be
          // defensive since other relays might use toolCallId.
          const toolCallId =
            typeof b.toolCallId === "string"
              ? (b.toolCallId as string)
              : typeof b.id === "string"
                ? (b.id as string)
                : "";

          const args = parseToolArguments(b.arguments);

          // Prefer toolCallId for a stable key; fall back to ordinal per assistant message.
          const stableId =
            toolCallId || `${message.key}:tool:${toolCallOrdinal++}`;
          const itemKey = `pending-tool:${stableId}`;

          const pending = pendingThinking as PendingThinking | null;
          const pendingText = pending?.thinking;
          const pendingDuration = pending?.duration;

          if (toolCallIndexByKey.has(itemKey)) {
            const idx = toolCallIndexByKey.get(itemKey)!;
            const existing = grouped[idx];

            grouped[idx] = {
              ...existing,
              toolName,
              toolInput: args,
              toolCallId: toolCallId || existing.toolCallId,
              thinking: pendingText ?? existing.thinking,
              thinkingDuration: pendingDuration ?? existing.thinkingDuration,
            };
          } else {
            toolCallIndexByKey.set(itemKey, grouped.length);
            if (toolCallId) toolCallIndexByCallId.set(toolCallId, grouped.length);

            pendingToolCalls.push({ toolCallId, toolName, args });

            grouped.push({
              key: itemKey,
              role: "tool",
              toolName,
              toolInput: args,
              toolCallId,
              content: null,
              timestamp: message.timestamp,
              thinking: pendingText,
              thinkingDuration: pendingDuration,
            });
          }

          pendingThinking = null; // Consumed
          continue;
        }

        buffer.push(block);
      }

      // Flush remaining assistant content after the last tool call.
      pushAssistantPart(false);

      // If this assistant message carries an error (e.g. model not found) but had
      // no visible content blocks, make sure it still appears in the output so the
      // error banner renders.
      if (message.stopReason === "error" && message.errorMessage) {
        const alreadyEmitted = grouped.some((g) => g.key === message.key || g.key.startsWith(`${message.key}:assistant:`));
        if (!alreadyEmitted) {
          grouped.push(message);
        }
      }
      continue;
    }

    if (message.role === "toolResult" || message.role === "tool") {
      // Prefer matching by toolCallId (reliable), fall back to tool name, then first available.
      let matchedPendingIndex = -1;

      if (message.toolCallId) {
        matchedPendingIndex = pendingToolCalls.findIndex(
          (p) => p.toolCallId && p.toolCallId === message.toolCallId
        );
      }

      if (matchedPendingIndex < 0) {
        const normalizedName = normalizeToolName(message.toolName);
        matchedPendingIndex = pendingToolCalls.findIndex(
          (p) => normalizeToolName(p.toolName) === normalizedName
        );
      }

      if (matchedPendingIndex < 0 && pendingToolCalls.length > 0) {
        matchedPendingIndex = 0;
      }

      const matched =
        matchedPendingIndex >= 0
          ? pendingToolCalls.splice(matchedPendingIndex, 1)[0]
          : undefined;

      const resolvedToolName = message.toolName ?? matched?.toolName;
      const resolvedArgs = matched?.args;
      const resolvedToolCallId = message.toolCallId ?? matched?.toolCallId;

      // If we already emitted a standalone item for this tool call, update it
      // in-place with the result so order is preserved.
      if (resolvedToolCallId) {
        const existingIdx = toolCallIndexByCallId.get(resolvedToolCallId);
        if (existingIdx !== undefined) {
          grouped[existingIdx] = {
            ...grouped[existingIdx],
            content: message.content,
            isError: message.isError,
            toolName: resolvedToolName,
            toolInput: resolvedArgs,
            toolCallId: resolvedToolCallId,
            timestamp: message.timestamp ?? grouped[existingIdx].timestamp,
            details: message.details ?? grouped[existingIdx].details,
            role: "tool",
          };
          continue;
        }

        // Fall back to the itemKey scheme (older placeholder keys).
        const itemKey = `pending-tool:${resolvedToolCallId}`;
        const existingIdxByKey = toolCallIndexByKey.get(itemKey);
        if (existingIdxByKey !== undefined) {
          grouped[existingIdxByKey] = {
            ...grouped[existingIdxByKey],
            content: message.content,
            isError: message.isError,
            toolName: resolvedToolName,
            toolInput: resolvedArgs,
            toolCallId: resolvedToolCallId,
            timestamp: message.timestamp ?? grouped[existingIdxByKey].timestamp,
            details: message.details ?? grouped[existingIdxByKey].details,
            role: "tool",
          };
          continue;
        }
      }

      // No pre-emitted item found — fall back to appending.
      grouped.push({
        ...message,
        toolName: resolvedToolName,
        toolInput: resolvedArgs,
        toolCallId: resolvedToolCallId,
      });
      continue;
    }

    grouped.push(message);
  }

  // Deduplicate by key — snapshots may contain both a streaming partial and the
  // final version of the same assistant message; keep the last occurrence (most complete).
  const seen = new Map<string, number>();
  for (let i = 0; i < grouped.length; i++) {
    seen.set(grouped[i].key, i);
  }
  return grouped.filter((_, i) => seen.get(grouped[i].key) === i);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent conversation grouping
// ─────────────────────────────────────────────────────────────────────────────

const SUB_AGENT_TOOLS = new Set([
  "send_message",
  "wait_for_message",
  "check_messages",
]);

function isSubAgentTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const norm = normalizeToolName(toolName);
  // strip MCP prefix (e.g. "mcp.send_message")
  const bare = norm.includes(".") ? norm.split(".").pop()! : norm;
  return SUB_AGENT_TOOLS.has(bare);
}

function messageToSubAgentTurn(msg: RelayMessage): SubAgentTurn {
  const toolName = msg.toolName ?? "";
  const norm = normalizeToolName(toolName);
  const bare = norm.includes(".") ? norm.split(".").pop()! : norm;
  const input = msg.toolInput && typeof msg.toolInput === "object"
    ? (msg.toolInput as Record<string, unknown>)
    : {};
  const hasOutput = hasVisibleContent(msg.content);
  const resultText = hasOutput ? extractTextFromToolContent(msg.content) : null;
  const isStreaming = !hasOutput && !resultText;

  if (bare === "send_message") {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "unknown";
    const message = typeof input.message === "string" ? input.message : "";
    const isError = resultText?.toLowerCase().startsWith("error") ?? false;
    return { type: "sent", sessionId, message, isStreaming, isError };
  }

  if (bare === "wait_for_message") {
    const fromSessionId = typeof input.fromSessionId === "string" ? input.fromSessionId : undefined;
    const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
    const hasMessage = resultText?.startsWith("Message from session") ?? false;
    const isTimedOut = resultText?.includes("No message received") ?? false;
    const isCancelled = resultText === "Wait was cancelled.";

    if (hasMessage && resultText) {
      const match = resultText.match(/^Message from session (.+?):\n\n([\s\S]*)$/);
      if (match) {
        return { type: "received", fromSessionId: match[1]!, message: match[2]! };
      }
    }
    return { type: "waiting", fromSessionId, timeout, isTimedOut, isCancelled, isStreaming };
  }

  // check_messages
  const fromSessionId = typeof input.fromSessionId === "string" ? input.fromSessionId : undefined;
  const isEmpty = resultText === "No pending messages.";
  const parsedMessages: Array<{ fromSessionId: string; message: string }> = [];
  if (resultText && !isEmpty) {
    const body = resultText.replace(/^\d+ message\(s\) received:\n\n/, "");
    const parts = body.split(/\n\n(?=\[)/);
    for (const part of parts) {
      const match = part.match(/^\[(.+?)\]\s([\s\S]*)$/);
      if (match) parsedMessages.push({ fromSessionId: match[1]!, message: match[2]! });
    }
  }
  return { type: "check", fromSessionId, messages: parsedMessages, isEmpty, isStreaming };
}

/**
 * Second grouping pass: collapses consecutive send_message / wait_for_message /
 * check_messages tool cards into a single "subAgentConversation" pseudo-message
 * rendered as a compact chat window.
 */
export function groupSubAgentConversations(messages: RelayMessage[]): RelayMessage[] {
  const result: RelayMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if ((msg.role !== "tool" && msg.role !== "toolResult") || !isSubAgentTool(msg.toolName)) {
      result.push(msg);
      i++;
      continue;
    }

    // Start of a sub-agent messaging run
    const startKey = msg.key;
    const turns: SubAgentTurn[] = [];
    let lastTimestamp = msg.timestamp;

    while (
      i < messages.length &&
      (messages[i]!.role === "tool" || messages[i]!.role === "toolResult") &&
      isSubAgentTool(messages[i]!.toolName)
    ) {
      const curr = messages[i]!;
      turns.push(messageToSubAgentTurn(curr));
      lastTimestamp = curr.timestamp ?? lastTimestamp;
      i++;
    }

    result.push({
      key: `sub-agent-convo:${startKey}`,
      role: "subAgentConversation",
      timestamp: lastTimestamp,
      content: null,
      subAgentTurns: turns,
    });
  }

  return result;
}
