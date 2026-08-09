export function matchesViewerGeneration(
  currentGeneration: number | undefined,
  payloadGeneration?: number,
): boolean {
  return payloadGeneration === undefined || currentGeneration === payloadGeneration;
}

export function matchesHydrationGeneration(
  currentGeneration: number | undefined,
  payloadGeneration: number | undefined,
  eventType: string,
  awaitingSnapshot: boolean,
): boolean {
  if (!awaitingSnapshot) {
    return matchesViewerGeneration(currentGeneration, payloadGeneration);
  }
  if (payloadGeneration !== undefined) {
    return payloadGeneration === currentGeneration;
  }
  return eventType === "session_active" || eventType === "agent_end";
}

/**
 * Drop events stamped with a different session's ID. Envelopes from older
 * servers have no sessionId and are accepted (generation/seq guards still
 * apply). Closes the switch race where old-room events are already in flight
 * when the viewer switches tabs — including a stale session_active being
 * accepted as the hydration snapshot.
 */
export function matchesViewerSession(
  activeSessionId: string | null,
  payloadSessionId?: string,
): boolean {
  return payloadSessionId === undefined || payloadSessionId === activeSessionId;
}

export function isActiveViewerSessionPayload(
  activeSessionId: string | null,
  payloadSessionId: string,
  currentGeneration: number | undefined,
  payloadGeneration?: number,
): boolean {
  return activeSessionId === payloadSessionId && matchesViewerGeneration(currentGeneration, payloadGeneration);
}
