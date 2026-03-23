import { describe, expect, test, mock, beforeAll } from "bun:test";

// mock.module MUST be registered before any import of the module under test
// (or modules that transitively import the mocked dependency).
// Static imports are hoisted and resolved before module-level code runs,
// so we register the mock here — at the very top — and then dynamically
// import the module under test inside beforeAll().
mock.module("../middleware.js", () => {
    return {
        requireSession: mock(() => Promise.resolve({ userId: "test-user", userName: "Test User" })),
        validateApiKey: mock(() => Promise.resolve({ userId: "test-user", userName: "Test User" })),
    };
});

// Controls the rate limiter behaviour for tests.
// Mutate these variables in individual tests to simulate allowed / blocked states.
let mockCheckAllowed = true;
let mockRetryAfterSeconds = 42;

mock.module("../security.js", () => {
    return {
        RateLimiter: class {
            check(_key: string): boolean {
                return mockCheckAllowed;
            }
            getRetryAfter(_key: string): number {
                return mockRetryAfterSeconds;
            }
            destroy() {}
        },
    };
});

let handleChatRoute: (req: Request, url: URL) => Promise<Response | undefined>;

beforeAll(async () => {
    // Dynamic import ensures the mock above is already in place when
    // ./chat.js (and its transitive dependency ../middleware.js) are loaded.
    const mod = await import("./chat.js");
    handleChatRoute = mod.handleChatRoute;
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
        mockCheckAllowed = false;
        mockRetryAfterSeconds = 42;

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
        mockCheckAllowed = false;
        mockRetryAfterSeconds = 42;

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
        mockCheckAllowed = false;
        mockRetryAfterSeconds = 30;

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
        mockCheckAllowed = true;

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
