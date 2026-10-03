import { expect, test } from "bun:test";
import { injectCodexWebSearch, isOpenAICodexWebSearchEnabled } from "./openai-codex-web-search.js";

test("injects web_search once, preserving existing tools", () => {
    const out = injectCodexWebSearch({ model: "x", tools: [{ type: "function", name: "read" }] }) as any;
    expect(out.tools).toEqual([{ type: "function", name: "read" }, { type: "web_search" }]);
    expect(injectCodexWebSearch(out)).toBe(out);
    expect((injectCodexWebSearch({}) as any).tools).toEqual([{ type: "web_search" }]);
});

test("env gate", () => {
    expect(isOpenAICodexWebSearchEnabled({})).toBe(false);
    expect(isOpenAICodexWebSearchEnabled({ PIZZAPI_OPENAI_CODEX_WEB_SEARCH: "off" })).toBe(false);
    expect(isOpenAICodexWebSearchEnabled({ PIZZAPI_OPENAI_CODEX_WEB_SEARCH: "1" })).toBe(true);
});
