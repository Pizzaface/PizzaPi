/**
 * Merge lastSeq from a viewer "connected" payload into the current cursor
 * without ever moving backward.
 */
export function mergeConnectedSeq(
  currentSeq: number | null,
  connectedLastSeq: number,
): number {
  if (!Number.isFinite(connectedLastSeq)) return currentSeq ?? 0;
  if (currentSeq === null) return connectedLastSeq;
  return Math.max(currentSeq, connectedLastSeq);
}
