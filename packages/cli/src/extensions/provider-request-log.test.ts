import { describe, test, expect } from "bun:test";
import { providerRequestLogExtension, isAnthropicMessagesUrl } from "./provider-request-log.js";

describe("providerRequestLogExtension", () => {
    test("wraps global fetch and passes through non-anthropic calls unchanged", async () => {
        const original = globalThis.fetch;
        try {
            let seen: any;
            globalThis.fetch = (async (input: any, init?: any) => {
                seen = { input, init };
                return new Response("ok");
            }) as unknown as typeof fetch;

            providerRequestLogExtension({} as any);
            // fetch should now be wrapped (different reference from our stub)
            expect(globalThis.fetch).not.toBe(original);

            const res = await globalThis.fetch("https://example.com/health", { method: "GET" });
            expect(await res.text()).toBe("ok");
            expect(seen.input).toBe("https://example.com/health");
        } finally {
            globalThis.fetch = original;
        }
    });

    test("does not throw when logging an anthropic /v1/messages request", async () => {
        const original = globalThis.fetch;
        try {
            globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
            providerRequestLogExtension({} as any);
            const body = JSON.stringify({
                model: "claude-fable-5",
                max_tokens: 100,
                system: [{ type: "text", text: "hi" }],
                messages: [{ role: "user", content: "x" }],
                tools: [{ name: "Bash" }],
                thinking: { type: "adaptive" },
            });
            const res = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { Authorization: "Bearer sk-ant-oat01-SECRETSECRET", "anthropic-beta": "oauth-2025-04-20" },
                body,
            });
            expect(res.status).toBe(200);
        } finally {
            globalThis.fetch = original;
        }
    });
});

// scripts/wire-tap.ts carries an identical copy of this predicate (it must stay
// dependency-free for vanilla pi, so it cannot import from src/) — keep them in
// sync by hand.
describe("isAnthropicMessagesUrl", () => {
    test("matches the real endpoint, with path suffixes and query strings", () => {
        expect(isAnthropicMessagesUrl("https://api.anthropic.com/v1/messages")).toBe(true);
        expect(isAnthropicMessagesUrl("https://api.anthropic.com/v1/messages?beta=true")).toBe(true);
        expect(isAnthropicMessagesUrl("https://api.anthropic.com/v1/messages/count_tokens")).toBe(true);
    });

    test("rejects lookalike and embedded hosts (substring confusion)", () => {
        expect(isAnthropicMessagesUrl("https://api.anthropic.com.evil.com/v1/messages")).toBe(false);
        expect(isAnthropicMessagesUrl("https://evil.com/?u=api.anthropic.com/v1/messages")).toBe(false);
        expect(isAnthropicMessagesUrl("https://api.anthropic.com%2eevil.com/v1/messages")).toBe(false);
    });

    test("rejects other hosts, wrong paths, and non-URLs", () => {
        expect(isAnthropicMessagesUrl("https://evil.com/v1/messages")).toBe(false);
        expect(isAnthropicMessagesUrl("https://api.anthropic.com/v1/complete")).toBe(false);
        expect(isAnthropicMessagesUrl("localhost:3000/api.anthropic.com/v1/messages")).toBe(false);
        expect(isAnthropicMessagesUrl("")).toBe(false);
    });
});