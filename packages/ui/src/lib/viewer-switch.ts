export function matchesViewerGeneration(
  currentGeneration: number | undefined,
  payloadGeneration?: number,
): boolean {
  return payloadGeneration === undefined || currentGeneration === payloadGeneration;
}

export function isActiveViewerSessionPayload(
  activeSessionId: string | null,
  payloadSessionId: string,
  currentGeneration: number | undefined,
  payloadGeneration?: number,
): boolean {
  return activeSessionId === payloadSessionId && matchesViewerGeneration(currentGeneration, payloadGeneration);
}
