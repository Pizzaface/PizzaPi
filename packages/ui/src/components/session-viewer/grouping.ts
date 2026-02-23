import type { RelayMessage } from "@/components/session-viewer/types";

import {
  hasVisibleContent,
  normalizeToolName,
} from "@/components/session-viewer/utils";

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
      return argumentsValue;
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
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall") continue;
    const toolName = typeof b.name === "string" ? b.name : "unknown";
    if (!shouldGroupToolCall(toolName)) continue;
    const id =
      typeof b.toolCallId === "string"
        ? b.toolCallId
        : typeof b.id === "string"
          ? b.id
          : "";
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * When the same assistant turn is represented multiple times in the message list
 * (e.g. a streaming partial saved alongside the final message), drop all earlier
 * copies so only the last (most complete) version gets split into grouped items.
 *
 * Two assistant messages are considered duplicates of the same turn when they
 * share at least one grouped-tool toolCallId.
 */
function deduplicateAssistantMessages(messages: RelayMessage[]): RelayMessage[] {
  // Build a map: toolCallId → last index of an assistant message that references it.
  const lastIndexForToolCallId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const ids = extractGroupedToolCallIds(msg);
    for (const id of ids) {
      lastIndexForToolCallId.set(id, i);
    }
  }

  if (lastIndexForToolCallId.size === 0) return messages;

  // Drop any assistant message that contains grouped tool calls but is NOT the
  // last message to reference all of those tool call IDs.
  return messages.filter((msg, i) => {
    if (msg.role !== "assistant") return true;
    const ids = extractGroupedToolCallIds(msg);
    if (ids.size === 0) return true;
    // Keep only if this index is the last for every id it contains.
    for (const id of ids) {
      if (lastIndexForToolCallId.get(id) !== i) return false;
    }
    return true;
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
