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

export function shouldDeferEventForHydration(
  eventType: string,
  awaitingSnapshot: boolean,
  chunkedDeliveryActive: boolean,
): boolean {
  const deferStreamingDeltas =
    eventType === "message_update" ||
    eventType === "message_start" ||
    eventType === "message_end" ||
    eventType === "turn_end" ||
    eventType === "tool_execution_start" ||
    eventType === "tool_execution_update" ||
    eventType === "tool_execution_end";

  if ((awaitingSnapshot || chunkedDeliveryActive) && deferStreamingDeltas) {
    return true;
  }

  // Chunks arriving before their session_active chunked header must be ignored.
  if (eventType === "session_messages_chunk" && awaitingSnapshot && !chunkedDeliveryActive) {
    return true;
  }

  return false;
}

export function registerChunkIndex(seenChunkIndexes: Set<number>, chunkIndex: number): boolean {
  if (seenChunkIndexes.has(chunkIndex)) {
    return false;
  }
  seenChunkIndexes.add(chunkIndex);
  return true;
}

export function canFinalizeChunkHydration(
  finalChunkSeen: boolean,
  seenChunkIndexes: Set<number>,
  totalChunks: number,
): boolean {
  if (!finalChunkSeen || !Number.isInteger(totalChunks) || totalChunks <= 0) {
    return false;
  }

  for (let i = 0; i < totalChunks; i++) {
    if (!seenChunkIndexes.has(i)) {
      return false;
    }
  }

  return true;
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
