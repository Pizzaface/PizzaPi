import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Injects OpenAI's hosted `web_search` tool into openai-codex (Responses API)
 * requests when PIZZAPI_OPENAI_CODEX_WEB_SEARCH is set. The search runs
 * server-side; web_search_call output items are ignored by pi's stream parser
 * and the model's answer arrives as normal text.
 */
export function isOpenAICodexWebSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
    const raw = env.PIZZAPI_OPENAI_CODEX_WEB_SEARCH?.trim().toLowerCase();
    return !!raw && !["0", "false", "no", "off"].includes(raw);
}

export function injectCodexWebSearch(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const body = payload as { tools?: Array<{ type?: string }> };
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.some((t) => t?.type === "web_search")) return payload;
    return { ...body, tools: [...tools, { type: "web_search" }] };
}

export const openaiCodexWebSearchExtension: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
        if (ctx.model?.provider !== "openai-codex" || !isOpenAICodexWebSearchEnabled()) return undefined;
        return injectCodexWebSearch(event.payload);
    });
};
