import { expect, test } from "bun:test";
import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { injectCodexWebSearch, isOpenAICodexWebSearchEnabled, openaiCodexWebSearchExtension } from "./openai-codex-web-search.js";

test("injects web_search once, preserving existing tools", () => {
    const out = injectCodexWebSearch({ model: "x", tools: [{ type: "function", name: "read" }] }) as any;
    expect(out.tools).toEqual([{ type: "function", name: "read" }, { type: "web_search" }]);
    expect(out.include).toEqual(["web_search_call.action.sources"]);
    expect(injectCodexWebSearch(out)).toBe(out);
    expect((injectCodexWebSearch({}) as any).tools).toEqual([{ type: "web_search" }]);
});

test("declares hosted search availability independently of MCP tool discovery", () => {
    const out = injectCodexWebSearch({ instructions: "Existing instructions" }) as { instructions: string };
    expect(out.instructions).toStartWith("Existing instructions");
    expect(out.instructions).toContain("hosted web_search");
    expect(out.instructions).toContain("search_tools");
    expect(out.instructions).toContain("not evidence that web search is unavailable");
    expect(out.instructions).toContain("Do not simulate a search with prose");
    expect(injectCodexWebSearch(out)).toBe(out);
});

test("adds instructions and source inclusion when hosted search is already present", () => {
    const out = injectCodexWebSearch({ tools: [{ type: "web_search" }], include: ["reasoning.encrypted_content"] }) as {
        tools: unknown[]; include: string[]; instructions: string;
    };
    expect(out.tools).toEqual([{ type: "web_search" }]);
    expect(out.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
    expect(out.instructions).toContain("hosted web_search");
});

test("request hook follows current provider and env flag, including model switches", async () => {
    const handlers = new Map<string, unknown>();
    // Only event registration is needed; requests below use the real handler.
    openaiCodexWebSearchExtension({ on: (name: string, handler: unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
    const request = handlers.get("before_provider_request") as (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown;
    const event: BeforeProviderRequestEvent = { type: "before_provider_request", payload: { instructions: "Original" } };
    const previous = process.env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH;
    try {
        process.env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH = "off";
        expect(await request(event, { model: { provider: "openai-codex" } } as ExtensionContext)).toBeUndefined();
        process.env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH = "1";
        expect(await request(event, { model: { provider: "anthropic" } } as ExtensionContext)).toBeUndefined();
        const out = await request(event, { model: { provider: "openai-codex" } } as ExtensionContext) as { instructions: string };
        expect(out.instructions).toContain("hosted web_search");
        expect(event.payload).toEqual({ instructions: "Original" });
    } finally {
        if (previous === undefined) delete process.env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH;
        else process.env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH = previous;
    }
});

test("env gate", () => {
    expect(isOpenAICodexWebSearchEnabled({})).toBe(false);
    expect(isOpenAICodexWebSearchEnabled({ PIZZAPI_OPENAI_CODEX_WEB_SEARCH: "off" })).toBe(false);
    expect(isOpenAICodexWebSearchEnabled({ PIZZAPI_OPENAI_CODEX_WEB_SEARCH: "1" })).toBe(true);
});
