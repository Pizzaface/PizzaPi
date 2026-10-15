import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Injects OpenAI's hosted `web_search` tool into openai-codex (Responses API)
 * requests when PIZZAPI_OPENAI_CODEX_WEB_SEARCH is set. The search runs
 * server-side; the patched pi-ai responses parser turns web_search_call items
 * into hidden _serverToolUse/_webSearchResult blocks rendered as search cards.
 */
const SOURCES = "web_search_call.action.sources";
const SEARCH_INSTRUCTIONS = "OpenAI's hosted web_search tool is available in this request. Use it directly for web lookups. It runs server-side and is not an MCP/function tool: search_tools or tool_search not listing it is not evidence that web search is unavailable. Prefer hosted search over scraping search engines with curl. Do not simulate a search with prose; if a search cannot run, say so plainly.";

export function isOpenAICodexWebSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
    const raw = env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH?.trim().toLowerCase();
    return !!raw && !["0", "false", "no", "off"].includes(raw);
}

export function injectCodexWebSearch(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const body = payload as { tools?: Array<{ type?: string }>; include?: string[]; instructions?: string };
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasSearch = tools.some((t) => t?.type === "web_search");
    // Sources feed the search card (via the pi-ai patch).
    const include = Array.isArray(body.include) ? body.include : [];
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const hasInstructions = instructions.includes(SEARCH_INSTRUCTIONS);
    if (hasSearch && include.includes(SOURCES) && hasInstructions) return payload;
    return {
        ...body,
        tools: hasSearch ? tools : [...tools, { type: "web_search" }],
        include: include.includes(SOURCES) ? include : [...include, SOURCES],
        instructions: hasInstructions ? instructions : `${instructions}\n\n${SEARCH_INSTRUCTIONS}`.trim(),
    };
}

export const openaiCodexWebSearchExtension: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
        if (ctx.model?.provider !== "openai-codex" || !isOpenAICodexWebSearchEnabled()) return undefined;
        return injectCodexWebSearch(event.payload);
    });
};
