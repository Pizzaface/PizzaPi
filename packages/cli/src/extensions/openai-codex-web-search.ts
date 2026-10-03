import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Injects OpenAI's hosted `web_search` tool into openai-codex (Responses API)
 * requests when PIZZAPI_OPENAI_CODEX_WEB_SEARCH is set. The search runs
 * server-side; the patched pi-ai responses parser turns web_search_call items
 * into hidden _serverToolUse/_webSearchResult blocks rendered as search cards.
 */
const SOURCES = "web_search_call.action.sources";

export function isOpenAICodexWebSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
    const raw = env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH?.trim().toLowerCase();
    return !!raw && !["0", "false", "no", "off"].includes(raw);
}

export function injectCodexWebSearch(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const body = payload as { tools?: Array<{ type?: string }>; include?: string[] };
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.some((t) => t?.type === "web_search")) return payload;
    // Sources feed the web search results card (via the pi-ai responses patch).
    const include = Array.isArray(body.include) ? body.include : [];
    return {
        ...body,
        tools: [...tools, { type: "web_search" }],
        include: include.includes(SOURCES) ? include : [...include, SOURCES],
    };
}

export const openaiCodexWebSearchExtension: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
        if (ctx.model?.provider !== "openai-codex" || !isOpenAICodexWebSearchEnabled()) return undefined;
        return injectCodexWebSearch(event.payload);
    });
};
