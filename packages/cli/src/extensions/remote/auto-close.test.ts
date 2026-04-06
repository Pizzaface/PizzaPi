/**
 * Tests for auto-close behavior on trigger-spawned sessions.
 *
 * The auto-close logic lives in lifecycle-handlers.ts's agent_end handler:
 * when PIZZAPI_WORKER_AUTO_CLOSE=true and the exit reason is "completed"
 * (no error, not killed), ctx.shutdown() is called immediately.
 *
 * Since lifecycle-handlers.ts has heavy dependencies (pi event system,
 * relay context, etc.), we test the decision logic in isolation here.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// ── Decision logic extracted from lifecycle-handlers.ts ───────────────────
// This mirrors the exact conditional in the agent_end handler.
function shouldAutoClose(opts: {
    autoCloseEnv: string | undefined;
    exitReason: "completed" | "killed" | "error";
    isChildSession: boolean;
    hasPendingMessages: boolean;
}): boolean {
    // Auto-close only applies to non-child sessions (trigger-spawned)
    if (opts.isChildSession) return false;
    // Only when explicitly enabled
    if (opts.autoCloseEnv !== "true") return false;
    // Only on successful completion
    if (opts.exitReason !== "completed") return false;
    // Only when there are no pending messages
    if (opts.hasPendingMessages) return false;
    return true;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("auto-close decision logic", () => {
    const savedEnv = process.env.PIZZAPI_WORKER_AUTO_CLOSE;

    afterEach(() => {
        if (savedEnv !== undefined) {
            process.env.PIZZAPI_WORKER_AUTO_CLOSE = savedEnv;
        } else {
            delete process.env.PIZZAPI_WORKER_AUTO_CLOSE;
        }
    });

    test("shuts down on successful completion when auto-close is enabled", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
        })).toBe(true);
    });

    test("does NOT shut down on error even when auto-close is enabled", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "error",
            isChildSession: false,
            hasPendingMessages: false,
        })).toBe(false);
    });

    test("does NOT shut down when killed even when auto-close is enabled", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "killed",
            isChildSession: false,
            hasPendingMessages: false,
        })).toBe(false);
    });

    test("does NOT shut down when auto-close is not set", () => {
        expect(shouldAutoClose({
            autoCloseEnv: undefined,
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
        })).toBe(false);
    });

    test("does NOT shut down when auto-close is 'false'", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "false",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
        })).toBe(false);
    });

    test("does NOT interfere with child sessions (follow-up grace takes precedence)", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: true,
            hasPendingMessages: false,
        })).toBe(false);
    });

    test("does NOT shut down when there are pending messages", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: true,
        })).toBe(false);
    });
});
