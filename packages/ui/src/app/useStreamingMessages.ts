import * as React from "react";
import type { RelayMessage } from "@/components/SessionViewer";
import { toRelayMessage } from "@/lib/message-helpers";
import { mergeStreamingPartials, mergeToolStreamPartials, upsertRelayMessage } from "./relay-message-merge";

/**
 * Streaming message pipeline: immediate upserts, RAF-debounced assistant
 * deltas, RAF-debounced tool output partials, and thinking-duration tracking.
 *
 * All returned callbacks are stable (they only close over refs and the stable
 * `setMessages` setter).
 */
export function useStreamingMessages(
  setMessages: (v: React.SetStateAction<RelayMessage[]>) => void,
) {
  // Debounce streaming delta updates (toolcall_delta, text_delta, thinking_delta) so we
  // flush at most once per animation frame instead of once per character.
  const pendingDeltaRef = React.useRef<Map<string, { raw: unknown; key: string }>>(new Map());
  const deltaRafRef = React.useRef<number | null>(null);
  // Key of the in-flight streaming partial message; evicted when the final message lands.
  const streamingPartialKeyRef = React.useRef<string | null>(null);

  // Separate RAF-based debounce for tool_execution_update streaming (e.g. bash
  // output). Kept independent of the assistant delta debounce above to avoid
  // interference with streamingPartialKeyRef / evictPartial logic.
  const pendingToolStreamRef = React.useRef<Map<string, unknown>>(new Map());
  const toolStreamRafRef = React.useRef<number | null>(null);

  // Track wall-clock timing of thinking blocks so we can bake duration into the content.
  // contentIndex → Date.now() at thinking_start
  const thinkingStartTimesRef = React.useRef<Map<number, number>>(new Map());
  // contentIndex → elapsed seconds at thinking_end
  const thinkingDurationsRef = React.useRef<Map<number, number>>(new Map());

  // Full reset: cancel the RAF and wipe all pending streaming state. Use before
  // replacing the entire message list (session_active, agent_end) so a queued
  // RAF can't staple a stale partial on top of the fresh snapshot.
  const cancelPendingDeltas = React.useCallback(() => {
    if (deltaRafRef.current !== null) {
      cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    pendingDeltaRef.current = new Map();
    streamingPartialKeyRef.current = null;
    thinkingStartTimesRef.current = new Map();
    thinkingDurationsRef.current = new Map();
    if (toolStreamRafRef.current !== null) {
      cancelAnimationFrame(toolStreamRafRef.current);
      toolStreamRafRef.current = null;
    }
    pendingToolStreamRef.current = new Map();
  }, []);

  const upsertMessage = React.useCallback((raw: unknown, fallback: string, evictPartial = false) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    if (evictPartial && streamingPartialKeyRef.current) {
      // Remove only the partial from the pending queue so the RAF can't
      // re-insert it after we evict it from state. We intentionally do NOT
      // clear streamingPartialKeyRef here — the setMessages callback below
      // still needs it to locate and splice out the partial from state.
      pendingDeltaRef.current.delete(streamingPartialKeyRef.current);
      if (pendingDeltaRef.current.size === 0 && deltaRafRef.current !== null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
    }

    setMessages((prev) => {
      let evictKey: string | null = null;
      if (evictPartial && streamingPartialKeyRef.current && streamingPartialKeyRef.current !== next.key) {
        evictKey = streamingPartialKeyRef.current;
        streamingPartialKeyRef.current = null;
      }
      return upsertRelayMessage(prev, next, evictKey);
    });
  }, []);

  const upsertMessageDebounced = React.useCallback((raw: unknown, fallback: string) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    streamingPartialKeyRef.current = next.key;
    pendingDeltaRef.current.set(next.key, { raw, key: next.key });

    if (deltaRafRef.current === null) {
      deltaRafRef.current = requestAnimationFrame(() => {
        deltaRafRef.current = null;
        const pending = pendingDeltaRef.current;
        pendingDeltaRef.current = new Map();
        setMessages((prev) => mergeStreamingPartials(prev, pending.values()));
      });
    }
  }, []);

  /**
   * Schedule a batched flush of pending tool_execution_update partials via RAF.
   * Each tool call accumulates its latest partial in pendingToolStreamRef, and
   * once per animation frame we upsert them into state as synthetic toolResult
   * messages so the UI renders live output (e.g. bash command streaming).
   */
  const scheduleToolStreamFlush = React.useCallback(() => {
    if (toolStreamRafRef.current !== null) return; // already scheduled
    toolStreamRafRef.current = requestAnimationFrame(() => {
      toolStreamRafRef.current = null;
      const pending = pendingToolStreamRef.current;
      if (pending.size === 0) return;
      pendingToolStreamRef.current = new Map();
      setMessages((prev) => mergeToolStreamPartials(prev, pending.values()));
    });
  }, []);

  return {
    pendingToolStreamRef,
    toolStreamRafRef,
    thinkingStartTimesRef,
    thinkingDurationsRef,
    cancelPendingDeltas,
    upsertMessage,
    upsertMessageDebounced,
    scheduleToolStreamFlush,
  };
}
