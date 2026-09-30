/**
 * Pure message-list merge helpers used by the viewer's streaming pipeline.
 *
 * These are the bodies of the `setMessages(prev => …)` updaters that used to
 * live inline in App.tsx. They never mutate `prev`; when nothing changes they
 * return `prev` itself so React can bail out.
 */
import type { RelayMessage } from "@/components/SessionViewer";
import { toRelayMessage } from "@/lib/message-helpers";

/**
 * Concatenate the text blocks of a message `content` (string or array of
 * `{ type: "text", text }` blocks). Returns "" for any other shape.
 * Not trimmed.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

/**
 * Insert or replace `next` in `prev`.
 *
 * - `evictKey`: key of an in-flight streaming partial to remove first (already
 *   resolved by the caller to be different from `next.key`), or null.
 * - Same key → replaced in place.
 * - A server-echoed user message replaces a locally-inserted optimistic steer
 *   message (`user:steer:*`) with identical trimmed text instead of appending
 *   a duplicate.
 * - Otherwise appended.
 */
export function upsertRelayMessage(
  prev: RelayMessage[],
  next: RelayMessage,
  evictKey: string | null,
): RelayMessage[] {
  let base = prev;
  if (evictKey) {
    const partialIdx = base.findIndex((m) => m.key === evictKey);
    if (partialIdx >= 0) {
      base = base.slice();
      base.splice(partialIdx, 1);
    }
  }
  const idx = base.findIndex((m) => m.key === next.key);
  if (idx >= 0) {
    const updated = base === prev ? base.slice() : base;
    updated[idx] = next;
    return updated;
  }

  // When a user message arrives from the server, check for a locally-inserted
  // steer message with the same content and replace it instead of appending a
  // duplicate. Steer messages are added optimistically with key "user:steer:*"
  // but the server echoes them back with a different key (e.g. "user:ts:*").
  if (next.role === "user") {
    const nextText = extractTextContent(next.content).trim();
    if (nextText) {
      const steerIdx = base.findIndex((m) =>
        m.key.startsWith("user:steer:") &&
        m.role === "user" &&
        (typeof m.content === "string" ? m.content.trim() : "") === nextText,
      );
      if (steerIdx >= 0) {
        const updated = base === prev ? base.slice() : base;
        updated[steerIdx] = next;
        return updated;
      }
    }
  }

  return [...base, next];
}

/**
 * Apply a batch of debounced assistant streaming partials (one RAF flush).
 *
 * A partial with a `:fallback:` key that doesn't match an existing message
 * adopts the key of the trailing message when that message is itself an
 * un-timestamped, non-error partial of the same role, so streaming updates
 * in place rather than appending a second bubble.
 */
export function mergeStreamingPartials(
  prev: RelayMessage[],
  pending: Iterable<{ raw: unknown; key: string }>,
): RelayMessage[] {
  let result = prev;
  let keyMap: Map<string, number> | null = null;

  for (const { raw: pendingRaw, key } of pending) {
    let msg = toRelayMessage(pendingRaw, key);
    if (!msg) continue;

    // Lazily initialize the map of existing keys to indices to convert
    // O(N*M) lookups into O(N+M)
    if (keyMap === null) {
      keyMap = new Map();
      for (let i = 0; i < result.length; i++) {
        keyMap.set(result[i].key, i);
      }
    }

    // Try to find an existing message by key
    let idx = keyMap.get(msg.key) ?? -1;

    // Heuristic: if not found, and it's a fallback key (streaming),
    // and the last message is itself a no-timestamp streaming partial
    // from the current turn, adopt its key to update in-place.
    // We must NOT adopt completed (timestamped) messages — that would
    // overwrite a previous turn's finished reply with new streaming
    // content, causing it to appear before the user's latest message.
    if (idx === -1 && msg.key.includes(":fallback:")) {
      const lastIdx = result.length - 1;
      if (lastIdx >= 0) {
        const last = result[lastIdx];
        if (last.role === msg.role && !last.isError && last.timestamp === undefined) {
          // Inherit the key from the existing partial so we update
          // in-place rather than appending a second streaming bubble.
          msg = { ...msg, key: last.key };
          idx = lastIdx;
        }
      }
    }

    if (idx >= 0) {
      if (result === prev) result = prev.slice();
      result[idx] = msg;
    } else {
      if (result === prev) result = prev.slice();
      result.push(msg);
      keyMap.set(msg.key, result.length - 1); // keep map updated for subsequent pending items
    }
  }
  return result;
}

/**
 * Apply a batch of buffered `tool_execution_update` partials (synthetic
 * toolResult messages) by key: replace in place or append.
 */
export function mergeToolStreamPartials(
  prev: RelayMessage[],
  pending: Iterable<unknown>,
): RelayMessage[] {
  let result = prev;
  let keyMap: Map<string, number> | null = null;

  for (const raw of pending) {
    const msg = toRelayMessage(raw, "tool-stream");
    if (!msg) continue;

    if (keyMap === null) {
      keyMap = new Map();
      for (let i = 0; i < result.length; i++) {
        keyMap.set(result[i].key, i);
      }
    }

    const idx = keyMap.get(msg.key) ?? -1;
    if (idx >= 0) {
      if (result === prev) result = prev.slice();
      result[idx] = msg;
    } else {
      if (result === prev) result = prev.slice();
      result.push(msg);
      keyMap.set(msg.key, result.length - 1); // keep map updated
    }
  }
  return result;
}
