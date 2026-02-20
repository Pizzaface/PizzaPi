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
function shouldGroupToolCall(toolName: string): boolean {
  const norm = normalizeToolName(toolName);
  return (
    norm === "bash" ||
    norm === "read" ||
    norm === "edit" ||
    norm.endsWith(".bash") ||
    norm.endsWith(".read") ||
    norm.endsWith(".edit")
  );
}

export function groupToolExecutionMessages(messages: RelayMessage[]): RelayMessage[] {
  // Map from tool item key → index in `grouped`.
  const toolCallIndexByKey = new Map<string, number>();
  // Map from toolCallId → index in `grouped`.
  const toolCallIndexByCallId = new Map<string, number>();

  // Fallback list for matching toolResult messages when toolCallId is absent.
  const pendingToolCalls: PendingToolCall[] = [];

  const grouped: RelayMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const blocks = message.content as unknown[];

      let assistantPartIndex = 0;
      let toolCallOrdinal = 0;
      let buffer: unknown[] = [];

      const pushAssistantPart = () => {
        if (!hasVisibleContent(buffer)) {
          buffer = [];
          return;
        }

        grouped.push({
          ...message,
          key: `${message.key}:assistant:${assistantPartIndex++}`,
          content: buffer,
        });
        buffer = [];
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
          pushAssistantPart();

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

          if (toolCallIndexByKey.has(itemKey)) {
            const idx = toolCallIndexByKey.get(itemKey)!;
            grouped[idx] = {
              ...grouped[idx],
              toolName,
              toolInput: args,
              toolCallId: toolCallId || grouped[idx].toolCallId,
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
            });
          }

          continue;
        }

        buffer.push(block);
      }

      // Flush remaining assistant content after the last tool call.
      pushAssistantPart();
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
