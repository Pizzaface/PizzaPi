import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { AuthStorage, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { defaultAgentDir, expandHome, loadConfig } from "../config.js";

const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CONTENT_CHARS = 8_000;
const DEFAULT_MAX_LINKS = 100;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaWebToolDeps {
  apiKey?: string;
  apiKeyProvider?: () => string | undefined | Promise<string | undefined>;
  defaultMaxResults?: number;
  maxContentChars?: number;
  maxLinks?: number;
  fetchFn?: FetchFn;
}

interface OllamaToolDetails {
  type: "web_search" | "web_fetch";
  query?: string;
  url?: string;
  maxResults?: number;
  resultCount?: number;
  linkCount?: number;
  truncated?: boolean;
  linksTruncated?: boolean;
  error?: string;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function envDefaultMaxResults(env: NodeJS.ProcessEnv = process.env): number {
  return clampInteger(env.PIZZAPI_OLLAMA_WEB_SEARCH_MAX_RESULTS, DEFAULT_MAX_RESULTS, 1, 10);
}

function envMaxContentChars(env: NodeJS.ProcessEnv = process.env): number {
  return clampInteger(env.PIZZAPI_OLLAMA_WEB_FETCH_MAX_CONTENT_CHARS, DEFAULT_MAX_CONTENT_CHARS, 1, 100_000);
}

function envMaxLinks(env: NodeJS.ProcessEnv = process.env): number {
  return clampInteger(env.PIZZAPI_OLLAMA_WEB_FETCH_MAX_LINKS, DEFAULT_MAX_LINKS, 1, 1_000);
}

export function isOllamaWebSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.PIZZAPI_OLLAMA_WEB_SEARCH?.trim().toLowerCase();
  if (!raw) return false;
  return !["0", "false", "no", "off"].includes(raw);
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

async function postJson(fetchFn: FetchFn, url: string, apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = `${response.status} ${response.statusText}`.trim();
    throw new Error(text ? `${message}: ${text}` : message);
  }

  return response.json();
}

function errorResult(type: OllamaToolDetails["type"], error: unknown, extra: Partial<OllamaToolDetails>) {
  const message = error instanceof Error ? error.message : String(error);
  const label = type === "web_search" ? "web_search" : "web_fetch";
  return {
    content: [{ type: "text" as const, text: `Ollama ${label} failed: ${message}` }],
    details: { type, ...extra, error: message } satisfies OllamaToolDetails,
  };
}

export function createOllamaWebTools(deps: OllamaWebToolDeps = {}): { webSearch: AgentTool<any, OllamaToolDetails>; webFetch: AgentTool<any, OllamaToolDetails> } {
  const getApiKey = deps.apiKeyProvider ?? (() => deps.apiKey ?? process.env.OLLAMA_API_KEY);
  const fetchFn = deps.fetchFn ?? (fetch as FetchFn);
  const defaultMaxResults = clampInteger(deps.defaultMaxResults, envDefaultMaxResults(), 1, 10);
  const maxContentChars = clampInteger(deps.maxContentChars, DEFAULT_MAX_CONTENT_CHARS, 1, 100_000);
  const maxLinks = clampInteger(deps.maxLinks, DEFAULT_MAX_LINKS, 1, 1_000);

  const webSearch: AgentTool<any, OllamaToolDetails> = {
    name: "web_search",
    label: "Ollama Web Search",
    description: "Search the web with Ollama's web search API. Use for current information, citations, and finding pages to fetch in detail.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return (1-10)" })),
    }),
    async execute(_toolCallId, params: any) {
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      const maxResults = clampInteger(params?.max_results, defaultMaxResults, 1, 10);
      if (!query) {
        return errorResult("web_search", "query is required", { query, maxResults });
      }
      const apiKey = await getApiKey();
      if (!apiKey) {
        return errorResult("web_search", "OLLAMA_API_KEY or stored ollama-cloud credentials are required", { query, maxResults });
      }

      try {
        const result = await postJson(fetchFn, OLLAMA_WEB_SEARCH_URL, apiKey, { query, max_results: maxResults });
        const rawResults = Array.isArray((result as any)?.results) ? (result as any).results : [];
        const webResults = rawResults
          .map((r: any) => ({
            type: "web_search_result",
            title: typeof r.title === "string" ? r.title : (typeof r.url === "string" ? r.url : "Untitled"),
            url: typeof r.url === "string" ? r.url : "",
          }))
          .filter((r: any) => r.url);
        return {
          content: [
            { type: "text" as const, text: "", _serverToolUse: { id: _toolCallId, name: "web_search", input: { query } } },
            { type: "text" as const, text: "", _webSearchResult: { tool_use_id: _toolCallId, content: webResults } },
          ],
          details: { type: "web_search", query, maxResults, resultCount: webResults.length },
        };
      } catch (error) {
        return errorResult("web_search", error, { query, maxResults });
      }
    },
  };

  const webFetch: AgentTool<any, OllamaToolDetails> = {
    name: "web_fetch",
    label: "Ollama Web Fetch",
    description: "Fetch a web page by URL with Ollama's web fetch API. Use after web_search when a full page is needed.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    async execute(_toolCallId, params: any) {
      const url = typeof params?.url === "string" ? params.url.trim() : "";
      if (!url) {
        return errorResult("web_fetch", "url is required", { url });
      }
      const apiKey = await getApiKey();
      if (!apiKey) {
        return errorResult("web_fetch", "OLLAMA_API_KEY or stored ollama-cloud credentials are required", { url });
      }

      try {
        const result = await postJson(fetchFn, OLLAMA_WEB_FETCH_URL, apiKey, { url });
        let truncated = false;
        const output = { ...(result as Record<string, unknown>) };
        if (typeof output.content === "string") {
          const next = truncate(output.content, maxContentChars);
          output.content = next.text;
          truncated = next.truncated;
        }
        const links = Array.isArray(output.links) ? output.links : undefined;
        const linkCount = links?.length;
        const linksTruncated = linkCount != null && linkCount > maxLinks;
        if (linksTruncated && links) {
          output.links = links.slice(0, maxLinks);
          output.links_truncated = linkCount - maxLinks;
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          details: { type: "web_fetch", url, linkCount, truncated, linksTruncated },
        };
      } catch (error) {
        return errorResult("web_fetch", error, { url });
      }
    },
  };

  return { webSearch, webFetch };
}

function createOllamaAuthStorage(): AuthStorage {
  const config = loadConfig(process.cwd());
  const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
  return AuthStorage.create(join(agentDir, "auth.json"));
}

export const ollamaWebToolsExtension: ExtensionFactory = (pi) => {
  if (!isOllamaWebSearchEnabled()) return;
  const auth = createOllamaAuthStorage();
  const tools = createOllamaWebTools({
    defaultMaxResults: envDefaultMaxResults(),
    maxContentChars: envMaxContentChars(),
    maxLinks: envMaxLinks(),
    apiKeyProvider: () => auth.getApiKey("ollama-cloud"),
  });
  // Only skip registering web_search when the default provider is Anthropic
  // AND Anthropic server-side web search is enabled (PIZZAPI_WEB_SEARCH=1).
  // In that case the provider patch injects its own native web_search tool —
  // registering both would cause a "Tool names must be unique" API error.
  // For other providers (Ollama, Google, etc.), web_search is always registered.
  const anthropicWsEnabled = typeof process !== "undefined" &&
    process.env.PIZZAPI_WEB_SEARCH &&
    !["0", "false", "no", "off"].includes(process.env.PIZZAPI_WEB_SEARCH.toLowerCase());
  let isAnthropicDefault = false;
  if (anthropicWsEnabled) {
    try {
      const settings = JSON.parse(readFileSync(join(homedir(), ".pizzapi", "settings.json"), "utf-8"));
      isAnthropicDefault = settings?.defaultProvider === "anthropic";
    } catch {
      // If we can't read settings, err on the side of registering the tool
    }
  }
  if (!(isAnthropicDefault && anthropicWsEnabled)) {
    pi.registerTool(tools.webSearch as any);
  }
  pi.registerTool(tools.webFetch as any);
};
