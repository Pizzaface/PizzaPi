import * as React from "react";
import type { QueuedMessage } from "@/lib/types";

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

export function resetSessionStateWithMessageQueueRef<State extends { messageQueue: QueuedMessage[] }>(
  createState: () => State,
  messageQueueRef: React.MutableRefObject<QueuedMessage[]>,
  setSessionState: React.Dispatch<React.SetStateAction<State>>,
): State {
  const next = createState();
  messageQueueRef.current = next.messageQueue;
  setSessionState(next);
  return next;
}
