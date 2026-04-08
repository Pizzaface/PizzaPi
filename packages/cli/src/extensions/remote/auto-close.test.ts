/**
 * Tests for auto-close behavior on trigger-spawned sessions.
 *
 * The auto-close logic lives in lifecycle-handlers.ts's agent_end handler:
 * when PIZZAPI_WORKER_AUTO_CLOSE=true and the exit reason is "completed"
 * (no error, not killed), ctx.shutdown() is called — unless the session
 * has active trigger subscriptions.
 *
 * Since lifecycle-handlers.ts has heavy dependencies (pi event system,
 * relay context, etc.), we test the decision logic in isolation here.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { shouldAutoClose } from "./auto-close.js";

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
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(true);
    });

    test("does NOT shut down on error even when auto-close is enabled", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "error",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT shut down when killed even when auto-close is enabled", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "killed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT shut down when auto-close is not set", () => {
        expect(shouldAutoClose({
            autoCloseEnv: undefined,
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT shut down when auto-close is 'false'", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "false",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT interfere with child sessions (follow-up grace takes precedence)", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: true,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT shut down when there are pending messages", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: true,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT shut down when session has active trigger subscriptions", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 2,
            linkedChildCount: 0,
        })).toBe(false);
    });

    test("does NOT shut down when session still has linked children", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 1,
        })).toBe(false);
    });

    test("shuts down when session has zero subscriptions and no linked children", () => {
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: 0,
        })).toBe(true);
    });

    test("does NOT shut down when linked-child count is unknown", () => {
        // Fail safe: if we can't prove there are no linked children, preserve the session.
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: 0,
            linkedChildCount: null,
        })).toBe(false);
    });

    test("does NOT shut down when subscription count is undefined (query failed)", () => {
        // If we can't check subscriptions, preserve the session.
        expect(shouldAutoClose({
            autoCloseEnv: "true",
            exitReason: "completed",
            isChildSession: false,
            hasPendingMessages: false,
            activeSubscriptionCount: undefined,
            linkedChildCount: 0,
        })).toBe(false);
    });
});
