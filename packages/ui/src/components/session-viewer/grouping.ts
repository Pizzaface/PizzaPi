import type { RelayMessage } from "@/components/session-viewer/types";

import { hasVisibleContent, normalizeToolName } from "@/components/session-viewer/utils";

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

export function groupToolExecutionMessages(
  messages: RelayMessage[]
): RelayMessage[] {
  // Map from toolCallId → index in `grouped` for already-emitted tool items.
  // This lets toolResult messages update the existing item in-place rather than
  // appending a new one, preserving insertion order (tool call comes first).
  const toolCallIndexById = new Map<string, number>();
  // Fallback list for matching by name when toolCallId is absent.
  const pendingToolCalls: PendingToolCall[] = [];
  const grouped: RelayMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      // Streaming partial messages have no timestamp — skip toolCall extraction
      // for them since they are mid-stream snapshots, not finalized messages.
      const isPartial = message.timestamp === undefined;

      const remainingBlocks: unknown[] = [];

      for (const block of message.content) {
        if (!block || typeof block !== "object") {
          remainingBlocks.push(block);
          continue;
        }

        const b = block as Record<string, unknown>;
        if (!isPartial && b.type === "toolCall") {
          // ToolCall blocks use `id` (not `toolCallId`) per pi-ai types
          const toolCallId = typeof b.id === "string" ? b.id : "";
          const toolName = typeof b.name === "string" ? b.name : "unknown";
          const args = parseToolArguments(b.arguments);

          // Use toolCallId when available for a stable key; fall back to a content hash.
          const stableId =
            toolCallId || `${toolName}:${JSON.stringify(args).slice(0, 120)}`;
          const itemKey = `pending-tool:${stableId}`;

          // Emit the tool call immediately as its own item (no result yet).
          // If we've already emitted this call (snapshot replay), update in-place.
          if (toolCallIndexById.has(itemKey)) {
            const idx = toolCallIndexById.get(itemKey)!;
            // Preserve any result already merged in; only refresh input.
            grouped[idx] = { ...grouped[idx], toolName, toolInput: args };
          } else {
            toolCallIndexById.set(itemKey, grouped.length);
            pendingToolCalls.push({ toolCallId, toolName, args });
            grouped.push({
              key: itemKey,
              role: "tool",
              toolName,
              toolInput: args,
              content: null,
            });
          }
          continue;
        }

        remainingBlocks.push(block);
      }

      if (hasVisibleContent(remainingBlocks)) {
        grouped.push({ ...message, content: remainingBlocks });
      }
      continue;
    }

    if (message.role === "toolResult" || message.role === "tool") {
      // Prefer matching by toolCallId (reliable), fall back to tool name, then first available
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

      // If we already emitted a standalone item for this tool call, update it
      // in-place with the result so order is preserved.
      if (matched?.toolCallId) {
        const stableId = matched.toolCallId;
        const itemKey = `pending-tool:${stableId}`;
        const existingIdx = toolCallIndexById.get(itemKey);
        if (existingIdx !== undefined) {
          grouped[existingIdx] = {
            ...grouped[existingIdx],
            content: message.content,
            isError: message.isError,
            toolName: resolvedToolName,
            toolInput: resolvedArgs,
          };
          continue;
        }
      }

      // No pre-emitted item found — fall back to appending (e.g. snapshot replay
      // where the assistant message was already deduplicated away).
      grouped.push({
        ...message,
        toolName: resolvedToolName,
        toolInput: resolvedArgs,
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
