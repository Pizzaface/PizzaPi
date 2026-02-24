import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RateLimiter, isValidEmail, isValidPassword, cwdMatchesRoots } from "./security";

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

    test("cwdMatchesRoots", () => {
        const root = "/home/user/project";
        // Exact match
        expect(cwdMatchesRoots([root], "/home/user/project")).toBe(true);
        // Child directory
        expect(cwdMatchesRoots([root], "/home/user/project/src")).toBe(true);

        // Path traversal attempts
        expect(cwdMatchesRoots([root], "/home/user/project/../../etc/passwd")).toBe(false);
        expect(cwdMatchesRoots([root], "/home/user/project/src/../../../etc/passwd")).toBe(false);

        // Partial folder name match (should fail)
        expect(cwdMatchesRoots([root], "/home/user/project-secret")).toBe(false);

        // Outside directory
        expect(cwdMatchesRoots([root], "/etc/passwd")).toBe(false);

        // Multiple roots
        const roots = ["/app/data", "/tmp"];
        expect(cwdMatchesRoots(roots, "/app/data/file.txt")).toBe(true);
        expect(cwdMatchesRoots(roots, "/tmp/temp.txt")).toBe(true);
        expect(cwdMatchesRoots(roots, "/app/config")).toBe(false);
    });
});
