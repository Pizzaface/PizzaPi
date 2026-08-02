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

export function isActiveViewerSessionPayload(
  activeSessionId: string | null,
  payloadSessionId: string,
  currentGeneration: number | undefined,
  payloadGeneration?: number,
): boolean {
  return activeSessionId === payloadSessionId && matchesViewerGeneration(currentGeneration, payloadGeneration);
}
