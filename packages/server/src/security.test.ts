import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RateLimiter, isValidEmail, isValidPassword } from "./security";

describe("RateLimiter", () => {
    test("allows requests within limit", () => {
        const limiter = new RateLimiter(2, 1000); // 2 requests per 1000ms
        const ip = "127.0.0.1";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(true);
        limiter.destroy();
    });

    test("blocks requests over limit", () => {
        const limiter = new RateLimiter(2, 1000);
        const ip = "127.0.0.2";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(false);
        limiter.destroy();
    });

    test("resets after window expires", async () => {
        const limiter = new RateLimiter(1, 100); // 1 request per 100ms
        const ip = "127.0.0.3";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(limiter.check(ip)).toBe(true);
        limiter.destroy();
    });
});

describe("Validation", () => {
    test("isValidEmail", () => {
        expect(isValidEmail("test@example.com")).toBe(true);
        expect(isValidEmail("user.name+tag@sub.domain.co.uk")).toBe(true);
        expect(isValidEmail("invalid")).toBe(false);
        expect(isValidEmail("user@")).toBe(false);
        expect(isValidEmail("@domain.com")).toBe(false);
    });

    test("isValidPassword", () => {
        expect(isValidPassword("12345678")).toBe(true);
        expect(isValidPassword("short")).toBe(false);
    });
});
