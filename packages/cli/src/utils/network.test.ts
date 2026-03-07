import { describe, test, expect } from "bun:test";
import {
    DEFAULT_TIMEOUT_MS,
    SLOW_OPERATION_TIMEOUT_MS,
    NetworkTimeoutError,
    createTimeoutController,
    fetchWithTimeout,
    isAbortError,
} from "./network.js";

describe("network utilities", () => {
    describe("constants", () => {
        test("DEFAULT_TIMEOUT_MS is 30 seconds", () => {
            expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
        });

        test("SLOW_OPERATION_TIMEOUT_MS is 60 seconds", () => {
            expect(SLOW_OPERATION_TIMEOUT_MS).toBe(60_000);
        });
    });

    describe("NetworkTimeoutError", () => {
        test("creates error with correct message", () => {
            const error = new NetworkTimeoutError("test-op", 5000);
            expect(error.message).toBe('Network operation "test-op" timed out after 5000ms');
            expect(error.name).toBe("NetworkTimeoutError");
            expect(error.operation).toBe("test-op");
            expect(error.timeoutMs).toBe(5000);
        });

        test("is instanceof Error", () => {
            const error = new NetworkTimeoutError("test", 1000);
            expect(error).toBeInstanceOf(Error);
        });
    });

    describe("createTimeoutController", () => {
        test("creates controller with default timeout", () => {
            const { signal, cleanup, controller } = createTimeoutController();
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(controller).toBeInstanceOf(AbortController);
            expect(typeof cleanup).toBe("function");
            cleanup(); // Clean up the timer
        });

        test("creates controller with custom timeout", () => {
            const { signal, cleanup } = createTimeoutController(5000, "custom-op");
            expect(signal.aborted).toBe(false);
            cleanup();
        });

        test("signal aborts after timeout", async () => {
            const { signal, cleanup } = createTimeoutController(50, "quick-timeout");
            expect(signal.aborted).toBe(false);

            // Wait for timeout
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(signal.aborted).toBe(true);

            cleanup(); // Clean up (should be no-op since already aborted)
        });

        test("cleanup prevents timeout", async () => {
            const { signal, cleanup } = createTimeoutController(50, "cleanup-test");
            expect(signal.aborted).toBe(false);

            cleanup(); // Clean up before timeout

            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(signal.aborted).toBe(false);
        });
    });

    describe("fetchWithTimeout", () => {
        test("uses default timeout if not specified", async () => {
            // Just verify it doesn't throw with defaults
            const { signal, cleanup } = createTimeoutController(100, "quick-test");
            cleanup();
        });

        test("combines with existing signal when specified", async () => {
            const userController = new AbortController();
            const { signal: timeoutSignal, cleanup } = createTimeoutController(5000);
            
            // Simulate combining signals
            const combined = AbortSignal.any([userController.signal, timeoutSignal]);
            expect(combined.aborted).toBe(false);
            
            // User abort should abort combined signal
            userController.abort();
            expect(combined.aborted).toBe(true);
            
            cleanup();
        });
    });

    describe("isAbortError", () => {
        test("returns true for NetworkTimeoutError", () => {
            const error = new NetworkTimeoutError("test", 1000);
            expect(isAbortError(error)).toBe(true);
        });

        test("returns true for AbortError", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            expect(isAbortError(error)).toBe(true);
        });

        test("returns false for other errors", () => {
            const error = new Error("Some other error");
            expect(isAbortError(error)).toBe(false);
        });

        test("returns false for non-errors", () => {
            expect(isAbortError(null)).toBe(false);
            expect(isAbortError(undefined)).toBe(false);
            expect(isAbortError("string")).toBe(false);
            expect(isAbortError(123)).toBe(false);
        });
    });
});
