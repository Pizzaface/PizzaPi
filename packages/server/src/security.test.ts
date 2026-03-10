import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RateLimiter, isValidEmail, isValidPassword, cwdMatchesRoots, getClientIp } from "./security";

describe("RateLimiter", () => {
    test("allows requests within limit", () => {
        const limiter = new RateLimiter(2, 1000);
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
        const limiter = new RateLimiter(1, 100);
        const ip = "127.0.0.3";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(limiter.check(ip)).toBe(true);
        limiter.destroy();
    });

    test("tracks different keys independently", () => {
        const limiter = new RateLimiter(1, 1000);
        expect(limiter.check("ip-a")).toBe(true);
        expect(limiter.check("ip-b")).toBe(true);
        expect(limiter.check("ip-a")).toBe(false);
        expect(limiter.check("ip-b")).toBe(false);
        limiter.destroy();
    });

    test("limit of 1 blocks second request immediately", () => {
        const limiter = new RateLimiter(1, 60000);
        expect(limiter.check("x")).toBe(true);
        expect(limiter.check("x")).toBe(false);
        expect(limiter.check("x")).toBe(false);
        limiter.destroy();
    });

    test("cleanup removes expired entries", async () => {
        const limiter = new RateLimiter(1, 50);
        limiter.check("a");
        limiter.check("b");
        // Both should have entries now
        expect(limiter.check("a")).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 100));

        // After window expires, both should be allowed again
        expect(limiter.check("a")).toBe(true);
        expect(limiter.check("b")).toBe(true);
        limiter.destroy();
    });
});

describe("isValidEmail", () => {
    test("accepts standard emails", () => {
        expect(isValidEmail("test@example.com")).toBe(true);
        expect(isValidEmail("user.name+tag@sub.domain.co.uk")).toBe(true);
        expect(isValidEmail("a@b.c")).toBe(true);
    });

    test("rejects emails without @", () => {
        expect(isValidEmail("invalid")).toBe(false);
        expect(isValidEmail("just-text")).toBe(false);
    });

    test("rejects emails with missing parts", () => {
        expect(isValidEmail("user@")).toBe(false);
        expect(isValidEmail("@domain.com")).toBe(false);
        expect(isValidEmail("@")).toBe(false);
    });

    test("rejects emails with spaces", () => {
        expect(isValidEmail("user @example.com")).toBe(false);
        expect(isValidEmail("user@ example.com")).toBe(false);
        expect(isValidEmail(" user@example.com")).toBe(false);
    });

    test("rejects empty string", () => {
        expect(isValidEmail("")).toBe(false);
    });

    test("rejects emails without TLD dot", () => {
        expect(isValidEmail("user@domain")).toBe(false);
    });
});

describe("isValidPassword", () => {
    test("accepts valid passwords (>=8 chars, 1 upper, 1 lower, 1 number)", () => {
        expect(isValidPassword("Abc12345")).toBe(true);
        expect(isValidPassword("ComplexPass1")).toBe(true);
        expect(isValidPassword("1234Abcd")).toBe(true);
    });

    test("rejects passwords < 8 characters", () => {
        expect(isValidPassword("Short1A")).toBe(false);
        expect(isValidPassword("1234567")).toBe(false);
        expect(isValidPassword("")).toBe(false);
    });

    test("rejects passwords missing required character types", () => {
        // No uppercase
        expect(isValidPassword("abcdefg1")).toBe(false);
        // No lowercase
        expect(isValidPassword("ABCDEFG1")).toBe(false);
        // No number
        expect(isValidPassword("Abcdefgh")).toBe(false);
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

describe("getClientIp", () => {
    test("extracts direct IP when no proxy", () => {
        const req = new Request("http://localhost", {
            headers: { "x-pizzapi-client-ip": "192.168.1.10" }
        });
        expect(getClientIp(req)).toBe("192.168.1.10");
    });

    test("defaults to unknown when no header", () => {
        const req = new Request("http://localhost");
        expect(getClientIp(req)).toBe("unknown");
    });

    test("respects X-Forwarded-For if direct IP is IPv4-mapped IPv6 private network", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "::ffff:172.18.0.22",
                "x-forwarded-for": "198.51.100.3"
            }
        });
        expect(getClientIp(req)).toBe("198.51.100.3");
    });

    test("respects X-Forwarded-For if direct IP is local loopback", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "127.0.0.1",
                "x-forwarded-for": "203.0.113.5, 198.51.100.2"
            }
        });
        expect(getClientIp(req)).toBe("203.0.113.5");
    });

    test("respects X-Forwarded-For if direct IP is private network (10.x)", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "10.42.0.5",
                "x-forwarded-for": "198.51.100.3"
            }
        });
        expect(getClientIp(req)).toBe("198.51.100.3");
    });

    test("respects X-Forwarded-For if direct IP is private network (172.16-31.x)", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "172.18.0.22",
                "x-forwarded-for": "198.51.100.3"
            }
        });
        expect(getClientIp(req)).toBe("198.51.100.3");
    });

    test("respects X-Forwarded-For if direct IP is private network (192.168.x)", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "192.168.1.100",
                "x-forwarded-for": "198.51.100.3"
            }
        });
        expect(getClientIp(req)).toBe("198.51.100.3");
    });

    test("ignores X-Forwarded-For if direct IP is not trusted", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "198.51.100.99",
                "x-forwarded-for": "203.0.113.5"
            }
        });
        expect(getClientIp(req)).toBe("198.51.100.99");
    });

    test("handles IPv6 loopback", () => {
        const req = new Request("http://localhost", {
            headers: {
                "x-pizzapi-client-ip": "::1",
                "x-forwarded-for": "10.0.0.5"
            }
        });
        expect(getClientIp(req)).toBe("10.0.0.5");
    });
});
