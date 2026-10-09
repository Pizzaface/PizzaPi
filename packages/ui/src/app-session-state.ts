import * as React from "react";
import type { QueuedMessage } from "@/lib/types";
import type { RelayMessage } from "@/components/SessionViewer";

export function applyMessageQueueUpdate<State extends { messageQueue: QueuedMessage[] }>(
  action: React.SetStateAction<QueuedMessage[]>,
  messageQueueRef: React.MutableRefObject<QueuedMessage[]>,
  setSessionState: React.Dispatch<React.SetStateAction<State>>,
): QueuedMessage[] {
  const next = typeof action === "function" ? action(messageQueueRef.current) : action;
  messageQueueRef.current = next;
  setSessionState((prev) => ({ ...prev, messageQueue: next }));
  return next;
}

/**
 * Write-through setter for `messages`. Computes `next` itself from
 * `messagesRef.current` (never from React's `prev.messages`) and updates the
 * ref synchronously before handing React a plain value to commit. This
 * guarantees `messagesRef.current` is correct immediately after this call
 * returns, even when another setMessages call is already pending in the same
 * batch — React only calls a functional updater eagerly/synchronously when no
 * other update is pending on the fiber, so reading the updater's return value
 * back out via an outer variable (the previous approach) was not reliable.
 */
export function applyMessagesUpdate<State extends { messages: RelayMessage[] }>(
  action: React.SetStateAction<RelayMessage[]>,
  messagesRef: React.MutableRefObject<RelayMessage[]>,
  setSessionState: React.Dispatch<React.SetStateAction<State>>,
): RelayMessage[] {
  const next = typeof action === "function" ? action(messagesRef.current) : action;
  messagesRef.current = next;
  setSessionState((prev) => ({ ...prev, messages: next }));
  return next;
}

export function resetSessionStateWithMessageQueueRef<State extends { messageQueue: QueuedMessage[]; messages: RelayMessage[] }>(
  createState: () => State,
  messageQueueRef: React.MutableRefObject<QueuedMessage[]>,
  messagesRef: React.MutableRefObject<RelayMessage[]>,
  setSessionState: React.Dispatch<React.SetStateAction<State>>,
): State {
  const next = createState();
  messageQueueRef.current = next.messageQueue;
  messagesRef.current = next.messages;
  setSessionState(next);
  return next;
}
