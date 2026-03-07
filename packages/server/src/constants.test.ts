import { describe, expect, test } from "bun:test";
import { TIMEOUTS, LIMITS } from "./constants.js";

describe("TIMEOUTS constants", () => {
    test("DEFAULT is 30 seconds", () => {
        expect(TIMEOUTS.DEFAULT).toBe(30_000);
    });
    test("SLOW_OPERATION is 60 seconds", () => {
        expect(TIMEOUTS.SLOW_OPERATION).toBe(60_000);
    });
    test("RETRY_BASE is 2 seconds", () => {
        expect(TIMEOUTS.RETRY_BASE).toBe(2_000);
    });
    test("RETRY_MAX is 60 seconds", () => {
        expect(TIMEOUTS.RETRY_MAX).toBe(60_000);
    });
});

describe("LIMITS constants", () => {
    test("MAX_TERMINAL_BUFFER_LINES is 10000", () => {
        expect(LIMITS.MAX_TERMINAL_BUFFER_LINES).toBe(10_000);
    });
    test("MAX_TERMINAL_BUFFER_BYTES is 1MB", () => {
        expect(LIMITS.MAX_TERMINAL_BUFFER_BYTES).toBe(1024 * 1024);
    });
    test("MAX_ATTACHMENTS is 1000", () => {
        expect(LIMITS.MAX_ATTACHMENTS).toBe(1000);
    });
    test("ATTACHMENT_TTL_MS is 15 minutes", () => {
        expect(LIMITS.ATTACHMENT_TTL_MS).toBe(15 * 60 * 1000);
    });
});
