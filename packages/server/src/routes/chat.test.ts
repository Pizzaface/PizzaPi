import { describe, expect, test, mock } from "bun:test";
import { handleChatRoute } from "./chat";
import * as middleware from "../middleware.js";

mock.module("../middleware.js", () => {
    return {
        requireSession: mock(() => Promise.resolve({ userId: "test-user", userName: "Test User" })),
        validateApiKey: mock(() => Promise.resolve({ userId: "test-user", userName: "Test User" })),
    };
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
