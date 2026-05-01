import { describe, expect, test } from "bun:test";
import { createOllamaWebTools, isOllamaWebSearchEnabled } from "./ollama-web-tools.js";

function textOf(result: Awaited<ReturnType<ReturnType<typeof createOllamaWebTools>["webSearch"]["execute"]>>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return first.text;
}

describe("Ollama web tools", () => {
  test("isOllamaWebSearchEnabled parses explicit boolean env values", () => {
    expect(isOllamaWebSearchEnabled({ PIZZAPI_OLLAMA_WEB_SEARCH: "1" })).toBe(true);
    expect(isOllamaWebSearchEnabled({ PIZZAPI_OLLAMA_WEB_SEARCH: "true" })).toBe(true);
    expect(isOllamaWebSearchEnabled({ PIZZAPI_OLLAMA_WEB_SEARCH: "yes" })).toBe(true);
    expect(isOllamaWebSearchEnabled({ PIZZAPI_OLLAMA_WEB_SEARCH: "0" })).toBe(false);
    expect(isOllamaWebSearchEnabled({ PIZZAPI_OLLAMA_WEB_SEARCH: "false" })).toBe(false);
    expect(isOllamaWebSearchEnabled({ PIZZAPI_OLLAMA_WEB_SEARCH: "off" })).toBe(false);
    expect(isOllamaWebSearchEnabled({})).toBe(false);
  });

  test("web_search calls Ollama REST API with bearer token and clamps max_results", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tools = createOllamaWebTools({
      apiKey: "ollama-key",
      defaultMaxResults: 7,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            results: [
              { title: "Ollama", url: "https://ollama.com/", content: "Cloud models are available." },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await tools.webSearch.execute("tc-search", { query: "what is ollama", max_results: 99 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ollama.com/api/web_search");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer ollama-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "what is ollama", max_results: 10 });
    expect(result.content[0].type).toBe("text");
    expect(textOf(result)).toContain("Cloud models are available.");
    expect(result.details).toEqual({ type: "web_search", query: "what is ollama", maxResults: 10, resultCount: 1 });
  });

  test("web_search can resolve credentials lazily from an async provider", async () => {
    let providerCalls = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tools = createOllamaWebTools({
      apiKeyProvider: async () => {
        providerCalls += 1;
        return "stored-ollama-key";
      },
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
    });

    await tools.webSearch.execute("tc-search", { query: "pizza" });

    expect(providerCalls).toBe(1);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer stored-ollama-key");
  });

  test("web_search uses configured default max results when omitted", async () => {
    let body: unknown;
    const tools = createOllamaWebTools({
      apiKey: "ollama-key",
      defaultMaxResults: 8,
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
    });

    await tools.webSearch.execute("tc-search", { query: "pizza" });

    expect(body).toEqual({ query: "pizza", max_results: 8 });
  });

  test("web_fetch calls Ollama REST API and truncates large content and link lists", async () => {
    const longContent = "x".repeat(80);
    let body: unknown;
    const tools = createOllamaWebTools({
      apiKey: "ollama-key",
      maxContentChars: 20,
      maxLinks: 2,
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            title: "Ollama",
            content: longContent,
            links: ["https://ollama.com/models", "https://ollama.com/search", "https://ollama.com/blog"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await tools.webFetch.execute("tc-fetch", { url: "https://ollama.com" });

    expect(body).toEqual({ url: "https://ollama.com" });
    const text = textOf(result);
    expect(text).toContain('"title": "Ollama"');
    expect(text).toContain("truncated");
    expect(text).toContain('"links_truncated": 1');
    expect(text).not.toContain("https://ollama.com/blog");
    expect(text.length).toBeLessThan(longContent.length + 200);
    expect(result.details).toEqual({ type: "web_fetch", url: "https://ollama.com", linkCount: 3, truncated: true, linksTruncated: true });
  });

  test("tools validate required inputs before calling Ollama", async () => {
    let calls = 0;
    const tools = createOllamaWebTools({
      apiKey: "ollama-key",
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    const searchResult = await tools.webSearch.execute("tc-search", { query: "   " });
    const fetchResult = await tools.webFetch.execute("tc-fetch", { url: "" });

    expect(calls).toBe(0);
    expect(textOf(searchResult)).toContain("query is required");
    expect(textOf(fetchResult as any)).toContain("url is required");
  });

  test("tools return an error when credentials are unavailable", async () => {
    let calls = 0;
    const tools = createOllamaWebTools({
      apiKeyProvider: () => undefined,
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    const result = await tools.webSearch.execute("tc-search", { query: "pizza" });

    expect(calls).toBe(0);
    expect(textOf(result)).toContain("OLLAMA_API_KEY or stored ollama-cloud credentials are required");
  });

  test("tools return error text with status and body when Ollama rejects a request", async () => {
    const tools = createOllamaWebTools({
      apiKey: "ollama-key",
      fetchFn: async () => new Response("bad key", { status: 401, statusText: "Unauthorized" }),
    });

    const result = await tools.webSearch.execute("tc-search", { query: "pizza" });

    expect(textOf(result)).toContain("Ollama web_search failed: 401 Unauthorized");
    expect(textOf(result)).toContain("bad key");
    expect(result.details).toMatchObject({ type: "web_search", error: "401 Unauthorized: bad key" });
  });
});
