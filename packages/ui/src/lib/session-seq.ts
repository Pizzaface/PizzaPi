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

export function analyzeIncomingSeq(
  currentSeq: number | null,
  incomingSeq: number,
): { accept: boolean; nextSeq: number | null; gap: boolean; expected: number | null } {
  if (!Number.isFinite(incomingSeq)) {
    return { accept: false, nextSeq: currentSeq, gap: false, expected: null };
  }

  if (currentSeq === null) {
    return { accept: true, nextSeq: incomingSeq, gap: false, expected: null };
  }

  if (incomingSeq < currentSeq) {
    return { accept: false, nextSeq: currentSeq, gap: false, expected: currentSeq + 1 };
  }

  if (incomingSeq === currentSeq) {
    return { accept: true, nextSeq: currentSeq, gap: false, expected: currentSeq + 1 };
  }

  const expected = currentSeq + 1;
  return {
    accept: true,
    nextSeq: incomingSeq,
    gap: incomingSeq > expected,
    expected,
  };
}
