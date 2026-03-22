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
