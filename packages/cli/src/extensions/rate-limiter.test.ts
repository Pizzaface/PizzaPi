import { describe, test, expect } from "bun:test";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
    test("allows events up to the limit", () => {
        const limiter = new RateLimiter(3, 60_000);
        expect(limiter.tryRecord()).toBe(true);
        expect(limiter.tryRecord()).toBe(true);
        expect(limiter.tryRecord()).toBe(true);
        expect(limiter.count).toBe(3);
    });

    test("blocks events beyond the limit", () => {
        const limiter = new RateLimiter(3, 60_000);
        limiter.tryRecord();
        limiter.tryRecord();
        limiter.tryRecord();
        expect(limiter.tryRecord()).toBe(false);
        expect(limiter.isLimited()).toBe(true);
    });

    test("isLimited returns false when under limit", () => {
        const limiter = new RateLimiter(5, 60_000);
        expect(limiter.isLimited()).toBe(false);
        limiter.record();
        expect(limiter.isLimited()).toBe(false);
    });

    test("reset clears all tracked events", () => {
        const limiter = new RateLimiter(2, 60_000);
        limiter.tryRecord();
        limiter.tryRecord();
        expect(limiter.isLimited()).toBe(true);
        limiter.reset();
        expect(limiter.isLimited()).toBe(false);
        expect(limiter.count).toBe(0);
    });

    test("old events expire after window passes", async () => {
        const limiter = new RateLimiter(2, 100); // 100ms window
        limiter.tryRecord();
        limiter.tryRecord();
        expect(limiter.isLimited()).toBe(true);

        // Wait for window to pass
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(limiter.isLimited()).toBe(false);
        expect(limiter.count).toBe(0);
        expect(limiter.tryRecord()).toBe(true);
    });

    test("count reflects current window only", () => {
        const limiter = new RateLimiter(10, 60_000);
        limiter.record();
        limiter.record();
        limiter.record();
        expect(limiter.count).toBe(3);
    });

    test("default values are 5 events per 60 seconds", () => {
        const limiter = new RateLimiter();
        expect(limiter.maxEvents).toBe(5);
        expect(limiter.windowMs).toBe(60_000);
    });
});
