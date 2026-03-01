export type InputDedupeState = {
  text: string;
  ts: number;
  phase: "pending" | "sent";
  attemptId: number;
};

export function shouldDeduplicateInput(
  state: InputDedupeState | null,
  text: string,
  now: number,
  windowMs = 500,
): boolean {
  if (!state || !text) return false;
  return state.text === text && now - state.ts < windowMs;
}

export function beginInputAttempt(
  text: string,
  now: number,
  attemptId: number,
): InputDedupeState {
  return {
    text,
    ts: now,
    phase: "pending",
    attemptId,
  };
}

export function failInputAttempt(
  state: InputDedupeState | null,
  attemptId: number,
): InputDedupeState | null {
  if (!state) return null;
  if (state.phase === "pending" && state.attemptId === attemptId) {
    return null;
  }
  return state;
}

export function completeInputAttempt(
  state: InputDedupeState | null,
  attemptId: number,
  now: number,
): InputDedupeState | null {
  if (!state) return null;
  if (state.phase === "pending" && state.attemptId === attemptId) {
    return {
      ...state,
      phase: "sent",
      ts: now,
    };
  }
  return state;
}
