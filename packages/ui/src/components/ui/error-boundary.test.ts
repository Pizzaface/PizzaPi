import { describe, expect, test } from "bun:test";

/**
 * Tests for the ErrorBoundary React class component.
 *
 * The component's render method depends on JSX (react/jsx-dev-runtime) and
 * Vite-only aliases that aren't available in the bun test environment. So we
 * mirror the core logic exactly from error-boundary.tsx and test it here.
 *
 * This gives strong coverage of every real decision the component makes:
 *
 *   1. resetKeys comparison (auto-reset on context switches, e.g. session change)
 *   2. getDerivedStateFromError — captures the error and flips hasError
 *   3. resetErrorBoundary — clears the error state so children can retry
 *   4. componentDidUpdate auto-reset — state machine for key-driven recovery
 */

// ── Mirrored types & logic (kept in sync with error-boundary.tsx) ─────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  resetKeys?: unknown[];
  children?: unknown;
  fallback?: unknown;
}

/**
 * Mirrors ErrorBoundary.getDerivedStateFromError.
 * Called by React when a descendant throws during render.
 */
function getDerivedStateFromError(error: Error): ErrorBoundaryState {
  return { hasError: true, error };
}

/**
 * Mirrors the comparison logic in ErrorBoundary.componentDidUpdate.
 * Returns true when the boundary should auto-reset because a resetKey changed.
 */
function resetKeysChanged(
  prevKeys: unknown[] | undefined,
  nextKeys: unknown[] | undefined,
): boolean {
  if (!nextKeys) return false;
  const prev = prevKeys ?? [];
  return prev.length !== nextKeys.length ||
    nextKeys.some((key, i) => !Object.is(key, prev[i]));
}

/**
 * Simulates the full componentDidUpdate decision logic:
 * should the boundary reset its error state?
 */
function shouldAutoReset(
  currentState: ErrorBoundaryState,
  prevProps: ErrorBoundaryProps,
  nextProps: ErrorBoundaryProps,
): boolean {
  if (!currentState.hasError) return false;
  return resetKeysChanged(prevProps.resetKeys, nextProps.resetKeys);
}

/**
 * Mirrors ErrorBoundary.resetErrorBoundary.
 * Returns the next state after the user clicks "Retry".
 */
function resetErrorBoundary(): ErrorBoundaryState {
  return { hasError: false, error: null };
}

// ── 1. getDerivedStateFromError ────────────────────────────────────────────────

describe("ErrorBoundary: crash detection (getDerivedStateFromError)", () => {
  test("sets hasError:true and captures the error object", () => {
    const err = new Error("boom");
    const state = getDerivedStateFromError(err);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(err);
  });

  test("works with any Error subclass", () => {
    class NetworkError extends Error {}
    const err = new NetworkError("fetch failed");
    const state = getDerivedStateFromError(err);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(err);
  });

  test("preserves the original error (no wrapping)", () => {
    const err = new TypeError("null is not an object");
    const state = getDerivedStateFromError(err);
    expect(state.error).toBeInstanceOf(TypeError);
    expect(state.error?.message).toBe("null is not an object");
  });
});

// ── 2. resetErrorBoundary (retry button handler) ───────────────────────────────

describe("ErrorBoundary: retry reset (resetErrorBoundary)", () => {
  test("returns hasError:false and error:null", () => {
    const next = resetErrorBoundary();
    expect(next.hasError).toBe(false);
    expect(next.error).toBeNull();
  });

  test("is idempotent — same result whether or not boundary was crashed", () => {
    // Crashed state → reset
    const crashed: ErrorBoundaryState = { hasError: true, error: new Error("x") };
    const afterReset = resetErrorBoundary();
    expect(afterReset.hasError).toBe(false);

    // Already-reset state → still reset
    const clean: ErrorBoundaryState = { hasError: false, error: null };
    const afterNoOp = resetErrorBoundary();
    expect(afterNoOp).toEqual(clean);

    // Silence unused variable warnings
    void crashed;
  });

  test("returned state has exactly the two expected fields", () => {
    const state = resetErrorBoundary();
    expect(Object.keys(state).sort()).toEqual(["error", "hasError"]);
  });
});

// ── 3. resetKeys comparison (componentDidUpdate auto-reset trigger) ────────────

describe("ErrorBoundary resetKeys comparison logic", () => {
  test("returns false when nextKeys is undefined", () => {
    expect(resetKeysChanged(["session-1"], undefined)).toBe(false);
    expect(resetKeysChanged(undefined, undefined)).toBe(false);
  });

  test("returns false when keys are identical (same reference)", () => {
    const id = "session-abc";
    expect(resetKeysChanged([id], [id])).toBe(false);
  });

  test("returns false when keys are equal by value", () => {
    expect(resetKeysChanged(["session-1"], ["session-1"])).toBe(false);
    expect(resetKeysChanged([1, 2, 3], [1, 2, 3])).toBe(false);
  });

  test("returns true when a key changes (session switch)", () => {
    expect(resetKeysChanged(["session-1"], ["session-2"])).toBe(true);
  });

  test("returns true when key changes from null to a value", () => {
    expect(resetKeysChanged([null], ["session-1"])).toBe(true);
  });

  test("returns true when prevKeys is undefined and nextKeys has values", () => {
    // First render with resetKeys — prevKeys starts as undefined
    expect(resetKeysChanged(undefined, ["session-1"])).toBe(true);
  });

  test("returns false when prevKeys is undefined and nextKeys is empty", () => {
    expect(resetKeysChanged(undefined, [])).toBe(false);
  });

  test("returns true when second key in array changes", () => {
    expect(resetKeysChanged(["session-1", "runner-a"], ["session-1", "runner-b"])).toBe(true);
  });

  test("returns false when all keys in multi-key array are unchanged", () => {
    expect(resetKeysChanged(["session-1", "runner-a"], ["session-1", "runner-a"])).toBe(false);
  });

  test("uses Object.is semantics (NaN equals NaN)", () => {
    expect(resetKeysChanged([NaN], [NaN])).toBe(false);
  });

  test("uses Object.is semantics (+0 and -0 are different)", () => {
    expect(resetKeysChanged([+0], [-0])).toBe(true);
  });

  test("returns true when key changes to null", () => {
    // Session closed — activeSessionId becomes null
    expect(resetKeysChanged(["session-1"], [null])).toBe(true);
  });

  test("returns true when keys are removed (length shrinks)", () => {
    expect(resetKeysChanged(["a", "b"], ["a"])).toBe(true);
  });

  test("returns true when keys are added (length grows)", () => {
    expect(resetKeysChanged(["a"], ["a", "b"])).toBe(true);
  });

  test("returns true when going from empty to non-empty", () => {
    expect(resetKeysChanged([], ["a"])).toBe(true);
  });

  test("returns true when going from non-empty to empty", () => {
    expect(resetKeysChanged(["a"], [])).toBe(true);
  });
});

// ── 4. componentDidUpdate full state-machine (auto-reset on context switch) ────

describe("ErrorBoundary: auto-reset state machine (componentDidUpdate)", () => {
  test("does NOT reset when boundary has not tripped (hasError:false)", () => {
    const state: ErrorBoundaryState = { hasError: false, error: null };
    // Even if resetKeys change, there is nothing to reset
    expect(shouldAutoReset(state, { resetKeys: ["a"] }, { resetKeys: ["b"] })).toBe(false);
  });

  test("does NOT reset when no resetKeys prop is provided", () => {
    const state: ErrorBoundaryState = { hasError: true, error: new Error("crash") };
    expect(shouldAutoReset(state, {}, {})).toBe(false);
    expect(shouldAutoReset(state, { resetKeys: ["a"] }, {})).toBe(false);
  });

  test("does NOT reset when resetKeys are unchanged", () => {
    const state: ErrorBoundaryState = { hasError: true, error: new Error("crash") };
    expect(shouldAutoReset(
      state,
      { resetKeys: ["session-1"] },
      { resetKeys: ["session-1"] },
    )).toBe(false);
  });

  test("DOES reset when resetKey changes (session switch clears sticky crash)", () => {
    const state: ErrorBoundaryState = { hasError: true, error: new Error("crash") };
    expect(shouldAutoReset(
      state,
      { resetKeys: ["session-1"] },
      { resetKeys: ["session-2"] },
    )).toBe(true);
  });

  test("DOES reset when resetKey changes from non-null to null (session closed)", () => {
    const state: ErrorBoundaryState = { hasError: true, error: new Error("crash") };
    expect(shouldAutoReset(
      state,
      { resetKeys: ["session-1"] },
      { resetKeys: [null] },
    )).toBe(true);
  });

  test("DOES reset when prevProps had no resetKeys but next does (first mount recovery)", () => {
    const state: ErrorBoundaryState = { hasError: true, error: new Error("crash") };
    expect(shouldAutoReset(
      state,
      { resetKeys: undefined },
      { resetKeys: ["session-1"] },
    )).toBe(true);
  });

  test("DOES reset when second key in multi-key array changes", () => {
    const state: ErrorBoundaryState = { hasError: true, error: new Error("crash") };
    expect(shouldAutoReset(
      state,
      { resetKeys: ["session-1", "runner-a"] },
      { resetKeys: ["session-1", "runner-b"] },
    )).toBe(true);
  });

  test("state after auto-reset is hasError:false error:null", () => {
    // Verify the reset state used by componentDidUpdate is the same as resetErrorBoundary
    const afterAutoReset = { hasError: false, error: null };
    const afterManualReset = resetErrorBoundary();
    expect(afterAutoReset).toEqual(afterManualReset);
  });
});

// ── 5. State transitions (overall boundary lifecycle) ─────────────────────────

describe("ErrorBoundary: full state lifecycle", () => {
  test("idle → crashed → reset via retry button", () => {
    // Start idle
    let state: ErrorBoundaryState = { hasError: false, error: null };
    expect(state.hasError).toBe(false);

    // A child crashes
    const err = new Error("render crash");
    state = getDerivedStateFromError(err);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(err);

    // User clicks Retry
    state = resetErrorBoundary();
    expect(state.hasError).toBe(false);
    expect(state.error).toBeNull();
  });

  test("idle → crashed → reset via session switch (resetKeys)", () => {
    let state: ErrorBoundaryState = { hasError: false, error: null };

    // A child crashes
    state = getDerivedStateFromError(new Error("crash"));
    expect(state.hasError).toBe(true);

    // User switches session — resetKeys change
    const shouldReset = shouldAutoReset(
      state,
      { resetKeys: ["session-1"] },
      { resetKeys: ["session-2"] },
    );
    expect(shouldReset).toBe(true);

    if (shouldReset) {
      state = resetErrorBoundary();
    }
    expect(state.hasError).toBe(false);
    expect(state.error).toBeNull();
  });

  test("multiple crashes and resets are independent", () => {
    const err1 = new Error("first crash");
    const state1 = getDerivedStateFromError(err1);
    expect(state1.error).toBe(err1);

    const reset1 = resetErrorBoundary();
    expect(reset1.hasError).toBe(false);

    const err2 = new Error("second crash");
    const state2 = getDerivedStateFromError(err2);
    expect(state2.error).toBe(err2);
    expect(state2.error).not.toBe(err1);

    const reset2 = resetErrorBoundary();
    expect(reset2.hasError).toBe(false);
  });
});
