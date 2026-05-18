/**
 * Pure helper functions for relay message normalization, deduplication,
 * model normalization, and thinking-duration augmentation.
 *
 * Extracted from App.tsx — no React dependencies, fully testable.
 */

import type { RelayMessage } from "@/components/session-viewer/types";
import type { ConfiguredModelInfo } from "@/lib/types";

export function toRelayMessage(raw: unknown, fallbackId: string): RelayMessage | null {
  if (!raw || typeof raw !== "object") return null;

  const msg = raw as Record<string, unknown>;
  const rawRole = typeof msg.role === "string" ? msg.role : "message";
  const role = rawRole === "tool_result" || rawRole === "toolresult" ? "toolResult" : rawRole;
  const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
  const id = typeof msg.id === "string" ? msg.id : undefined;

  const normalizedRole = role.toLowerCase();
  const isToolMessage = normalizedRole === "tool" || normalizedRole === "toolresult";

  const key = isToolMessage && toolCallId
    ? `tool-call:${toolCallId}`
    : id
      ? `${role}:id:${id}`
      : toolCallId
        ? `${role}:tool:${toolCallId}`
        : timestamp !== undefined
          ? `${role}:ts:${timestamp}`
          : `${role}:fallback:${fallbackId}`;

  const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
  const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : undefined;

  // Extract summary/tokensBefore for compactionSummary / branchSummary messages
  const summary = typeof msg.summary === "string" ? msg.summary : undefined;
  const tokensBefore = typeof msg.tokensBefore === "number" ? msg.tokensBefore : undefined;

  // Preserve structured details (e.g., subagent SubagentDetails) for tool results
  const details = msg.details !== undefined && msg.details !== null ? msg.details : undefined;

  // Preserve custom-message metadata so the viewer can label extension/context
  // messages with their full key instead of only the generic "custom" role.
  const customType = typeof msg.customType === "string" ? msg.customType : undefined;
  const display = typeof msg.display === "boolean" ? msg.display : undefined;

  return {
    key,
    role,
    timestamp,
    content: msg.content,
    toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
    toolCallId: toolCallId || undefined,
    isError: msg.isError === true || stopReason === "error",
    stopReason,
    errorMessage,
    summary,
    tokensBefore,
    details,
    customType,
    display,
    isStreamingPartial: msg.isStreamingPartial === true ? true : undefined,
  };
}

function getAssistantToolCallIds(msg: RelayMessage): string[] {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall") continue;
    const id =
      typeof b.toolCallId === "string"
        ? b.toolCallId
        : typeof b.id === "string"
          ? b.id
          : "";
    if (id) ids.push(id);
  }
  return ids;
}

/** Extract concatenated text content from an assistant message for dedup comparison. */
function extractAssistantText(msg: RelayMessage): string {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  let text = "";
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

/** Deduplicate assistant messages within a list. Removes no-timestamp partials
 * that are superseded by timestamped finals, even across chunk boundaries. */
export function deduplicateMessages(messages: RelayMessage[]): RelayMessage[] {
  // Build a set of toolCallIds referenced by any timestamped assistant message.
  const timestampedToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.timestamp !== undefined) {
      for (const id of getAssistantToolCallIds(msg)) {
        timestampedToolCallIds.add(id);
      }
    }
  }

  const dropIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i];
    if (cur.role !== "assistant" || cur.timestamp !== undefined) continue;

    // Original heuristic: immediately followed by a timestamped assistant message.
    const next = messages[i + 1];
    if (next?.role === "assistant" && next.timestamp !== undefined) {
      dropIndices.add(i);
      continue;
    }

    // Extended heuristic: shares a toolCallId with any later timestamped assistant message.
    const ids = getAssistantToolCallIds(cur);
    if (ids.length > 0 && ids.some((id) => timestampedToolCallIds.has(id))) {
      dropIndices.add(i);
      continue;
    }

    // Text-prefix heuristic: if this no-timestamp message has no toolCallIds,
    // check if any later timestamped assistant message contains the same text
    // (the partial is a prefix of the final). This catches text-only streaming
    // partials that survive alongside the final message (e.g. after web_search).
    if (ids.length === 0) {
      const curText = extractAssistantText(cur);
      if (curText) {
        for (let j = i + 1; j < messages.length; j++) {
          const candidate = messages[j];
          if (candidate.role !== "assistant" || candidate.timestamp === undefined) continue;
          const candidateText = extractAssistantText(candidate);
          if (candidateText && candidateText.startsWith(curText)) {
            dropIndices.add(i);
            break;
          }
        }
      }
    }
  }

  if (dropIndices.size === 0) return messages;
  return messages.filter((_, i) => !dropIndices.has(i));
}

/**
 * Merge a finalized chunk snapshot with the previous message state.
 *
 * The assembled snapshot takes precedence for every message ID it covers, but
 * any messages already in `prev` whose keys are *not* present in the snapshot
 * (e.g. MCP auth banners, local system messages injected during hydration) are
 * preserved by appending them after the snapshot messages.
 */
export function mergeChunkSnapshot(
  snapshotMessages: RelayMessage[],
  prev: RelayMessage[],
): RelayMessage[] {
  const snapshotKeys = new Set(snapshotMessages.map((m) => m.key));
  const preserved = prev.filter((m) => !snapshotKeys.has(m.key));
  return preserved.length > 0 ? [...snapshotMessages, ...preserved] : snapshotMessages;
}

/**
 * Build a synthetic streaming-partial `RelayMessage` from a `tool_execution_update`
 * event's `partialResult`. The shape produced here MUST match the shape of the
 * final tool result delivered via `message_end` so the rendering pipeline
 * (extractTextFromToolContent / hasVisibleContent / BashToolCard) handles it
 * identically:
 *
 *   - `content`  — the raw content array/string from `partialResult.content`
 *                  (NOT wrapped in `{ content, details }`)
 *   - `details`  — the structured details object as a sibling field
 *
 * Bundling `{ content, details }` into the `content` field would hide the
 * partial text from `extractTextFromToolContent` (which only unwraps an
 * object's `.content` when it is a string, not an array), causing the Terminal
 * pane in `BashToolCard` to render an empty pane until `tool_execution_end`
 * delivers the final result — i.e. no live streaming output.
 */
export function buildStreamingPartialMessage(input: {
  toolCallId: string;
  toolName: string;
  partialResult: unknown;
}): RelayMessage {
  const partial =
    input.partialResult && typeof input.partialResult === "object"
      ? (input.partialResult as Record<string, unknown>)
      : null;
  const content = partial ? partial.content : undefined;
  const details = partial ? partial.details : undefined;
  return {
    key: `tool-call:${input.toolCallId}`,
    role: "toolResult",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content,
    details,
    isError: false,
    // Mark as a streaming partial so deduplication logic does not treat it as
    // a terminal tool result (the tool is still in-flight).
    isStreamingPartial: true,
  };
}

export function normalizeMessages(rawMessages: unknown[], keyOffset = 0): RelayMessage[] {
  const all = rawMessages
    .map((m, i) => toRelayMessage(m, `snapshot-${keyOffset + i}`))
    .filter((m): m is RelayMessage => m !== null);

  return deduplicateMessages(all);
}

export function normalizeModel(raw: unknown): ConfiguredModelInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const model = raw as Record<string, unknown>;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  // Accept both `id` (availableModels shape) and `modelId` (buildSessionContext shape)
  const id = (typeof model.id === "string" ? model.id.trim() : "") ||
              (typeof model.modelId === "string" ? model.modelId.trim() : "");
  if (!provider || !id) return null;

  return {
    provider,
    id,
    name: typeof model.name === "string" ? model.name : undefined,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
  };
}

export function normalizeSessionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Inject `durationSeconds` into thinking blocks that we've timed client-side. */
export function augmentThinkingDurations(message: unknown, durations: Map<number, number>): unknown {
  if (!message || typeof message !== "object" || durations.size === 0) return message;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return message;
  let changed = false;
  const content = msg.content.map((block, i) => {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "thinking" && durations.has(i) && b.durationSeconds === undefined) {
      changed = true;
      return { ...b, durationSeconds: durations.get(i) };
    }
    return block;
  });
  return changed ? { ...msg, content } : message;
}

export function normalizeModelList(rawModels: unknown[]): ConfiguredModelInfo[] {
  const deduped = new Map<string, ConfiguredModelInfo>();
  for (const raw of rawModels) {
    const model = normalizeModel(raw);
    if (!model) continue;
    deduped.set(`${model.provider}/${model.id}`, model);
  }
  return Array.from(deduped.values()).sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

/** Normalize a raw commands array from capabilities / session_active events. */
export function normalizeCommandList(
  rawCommands: unknown[],
): Array<{ name: string; description?: string; source?: string }> {
  return rawCommands
    .filter(
      (c): c is Record<string, unknown> =>
        c !== null &&
        typeof c === "object" &&
        typeof (c as Record<string, unknown>).name === "string",
    )
    .map((c) => ({
      name: String(c.name),
      description: typeof c.description === "string" ? c.description : undefined,
      source: typeof c.source === "string" ? c.source : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
