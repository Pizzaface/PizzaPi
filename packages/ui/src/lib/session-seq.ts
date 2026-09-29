/**
 * Merge lastSeq from a viewer "connected" payload into the current cursor.
 *
 * "connected" is a bare handshake ack: it is emitted before any transcript is
 * sent, and hydration may still deliver nothing at all. So it must never move
 * the cursor *forward* — doing so claims we hold content we were never sent,
 * and the server then answers the next resume with "you are already current"
 * and no transcript, forever. That is the blank-until-refresh bug.
 *
 * A *backward* move is still accepted: a relay restart resets the seq counter,
 * and keeping a stale high cursor would reject every subsequent event.
 */
export function mergeConnectedSeq(
  currentSeq: number | null,
  connectedLastSeq: number,
): number {
  if (!Number.isFinite(connectedLastSeq)) return currentSeq ?? 0;
  if (currentSeq === null) return connectedLastSeq;
  return Math.min(currentSeq, connectedLastSeq);
}

export function shouldDeferEventForHydration(
  eventType: string,
  awaitingSnapshot: boolean,
): boolean {
  // Deltas cannot be applied before the first snapshot has set the transcript.
  return awaitingSnapshot && (
    eventType === "message_update" ||
    eventType === "message_start" ||
    eventType === "message_end" ||
    eventType === "turn_end" ||
    eventType === "tool_execution_start" ||
    eventType === "tool_execution_update" ||
    eventType === "tool_execution_end"
  );
}

export function shouldAllowOutOfOrderSnapshotDuringHydration(
  eventType: string,
  awaitingSnapshot: boolean,
  currentSeq: number | null,
  incomingSeq: number,
): boolean {
  if (!awaitingSnapshot) return false;
  if (eventType !== "session_active" && eventType !== "agent_end") return false;
  if (currentSeq === null) return false;
  if (!Number.isFinite(incomingSeq)) return false;
  return incomingSeq < currentSeq;
}

/**
 * Decide whether a replayed delta may advance the cursor.
 *
 * Unlike the live path, replay events must be strictly monotonic — they must
 * never rewind the cursor. A stale replayed delta (seq <= current) is dropped
 * so cached deltas emitted by the resync endpoint after a live gap cannot
 * reapply stale state or move the cursor backward.
 */
export function analyzeReplaySeq(
  currentSeq: number | null,
  incomingSeq: number,
): { accept: boolean; nextSeq: number | null } {
  if (!Number.isFinite(incomingSeq)) {
    return { accept: false, nextSeq: currentSeq };
  }
  if (currentSeq === null) {
    return { accept: true, nextSeq: incomingSeq };
  }
  // ponytail: strict monotonic — only advance, never rewind
  if (incomingSeq <= currentSeq) {
    return { accept: false, nextSeq: currentSeq };
  }
  return { accept: true, nextSeq: incomingSeq };
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
