import { describe, expect, test, mock, spyOn, beforeAll, afterEach } from "bun:test";
import type { Mock } from "bun:test";

// mock.module for middleware must be registered before the dynamic import below.
// The rate-limiter mock is no longer needed here — we spy directly on the exported
// chatRateLimiter instance, which avoids the module-cache ordering problem that
// previously caused failures when this file and index.test.ts ran together.
mock.module("../middleware.js", () => {
    return {
        requireSession: mock(() => Promise.resolve({ userId: "test-user", userName: "Test User" })),
        validateApiKey: mock(() => Promise.resolve({ userId: "test-user", userName: "Test User" })),
    };
});

let handleChatRoute: (req: Request, url: URL) => Promise<Response | undefined>;
let checkSpy: Mock<(key: string) => boolean>;
let getRetryAfterSpy: Mock<(key: string) => number>;

beforeAll(async () => {
    // Dynamic import ensures the middleware mock above is in place before chat.js loads.
    // The 30_000 ms timeout accounts for cold-loading heavy transitive dependencies.
    const mod = await import("./chat.js");
    handleChatRoute = mod.handleChatRoute;

    // Spy on the exported rate-limiter instance so tests can control its behavior
    // regardless of which order this file and index.test.ts are loaded.
    checkSpy = spyOn(mod.chatRateLimiter, "check").mockReturnValue(true) as Mock<(key: string) => boolean>;
    getRetryAfterSpy = spyOn(mod.chatRateLimiter, "getRetryAfter").mockReturnValue(42) as Mock<(key: string) => number>;
}, 30_000);

afterEach(() => {
    // Restore default spy return values so tests start from a known state.
    checkSpy.mockReturnValue(true);
    getRetryAfterSpy.mockReturnValue(42);
});

describe("handleChatRoute", () => {
    test("returns 400 for malformed JSON body", async () => {
        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: "{ malformed ",
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);

        const data = await res!.json();
        expect(data).toEqual({ error: "Invalid JSON body" });
    });

    test("returns 400 for valid JSON null body", async () => {
        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify(null),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);

        const data = await res!.json();
        expect(data).toEqual({ error: "Invalid JSON body" });
    });

    test("returns 400 for valid JSON array body", async () => {
        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify([]),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);

        const data = await res!.json();
        expect(data).toEqual({ error: "Invalid JSON body" });
    });

    test("returns 400 for valid JSON primitive body", async () => {
        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify(42),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);

        const data = await res!.json();
        expect(data).toEqual({ error: "Invalid JSON body" });
    });

    test("returns 400 for valid JSON body with missing fields", async () => {
        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify({ message: "Hello", provider: "mock-provider" }),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);

        const data = await res!.json();
        expect(data).toEqual({ error: "Missing required fields: message, provider, model" });
    });
});

describe("handleChatRoute — rate limiting", () => {
    test("returns 429 when rate limit is exceeded", async () => {
        checkSpy.mockReturnValue(false);
        getRetryAfterSpy.mockReturnValue(42);

        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify({ message: "Hello", provider: "anthropic", model: "claude-3-haiku" }),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(429);
    });

    test("returns Retry-After header when rate limited", async () => {
        checkSpy.mockReturnValue(false);
        getRetryAfterSpy.mockReturnValue(42);

        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify({ message: "Hello", provider: "anthropic", model: "claude-3-haiku" }),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.headers.get("Retry-After")).toBe("42");
    });

    test("returns JSON error body when rate limited", async () => {
        checkSpy.mockReturnValue(false);
        getRetryAfterSpy.mockReturnValue(30);

        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            body: JSON.stringify({ message: "Hello", provider: "anthropic", model: "claude-3-haiku" }),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        const data = await res!.json();
        expect(data).toHaveProperty("error");
        expect(typeof data.error).toBe("string");
    });

    test("proceeds past rate limit check when allowed", async () => {
        checkSpy.mockReturnValue(true);

        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, {
            method: "POST",
            // Missing 'model' field — triggers a 400, which confirms we passed the rate limit check
            body: JSON.stringify({ message: "Hello", provider: "anthropic" }),
        });

        const res = await handleChatRoute(req, url);
        expect(res).toBeDefined();
        // Must NOT be 429; a 400 (missing fields) means we got past the rate limiter
        expect(res!.status).toBe(400);
    });
});
