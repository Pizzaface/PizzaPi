/**
 * Server-side tool enrichment dispatcher.
 *
 * Anthropic's server-side tools (web search, etc.) are stored as regular
 * `type: "text"` blocks with hidden metadata properties (`_serverToolUse`,
 * `_webSearchResult`). This module detects those properties and returns
 * the appropriate card component — or `null` for plain text blocks.
 *
 * To add a new server tool:
 *   1. Create a card component in `./cards/`
 *   2. Add a detection case in `tryRenderServerToolBlock()`
 */

import * as React from "react";
import {
  WebSearchQueryCard,
  WebSearchResultsCard,
  type WebSearchResult,
} from "./cards/WebSearchCard";

// ── Types for server tool metadata ──────────────────────────────────────────

interface ServerToolUseMetadata {
  id: string;
  name: string;
  input: { query?: string; [key: string]: unknown };
}

interface WebSearchResultBlock {
  type: "web_search_result";
  title: string;
  url: string;
  [key: string]: unknown;
}

interface WebSearchResultMetadata {
  tool_use_id: string;
  content: WebSearchResultBlock[];
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Check a text content block for server-side tool metadata and return
 * the appropriate card component. Returns `null` if the block is a
 * plain text block with no server tool enrichment.
 *
 * @param block - A content block with `type: "text"` from the message stream.
 * @param key   - React key for the returned element.
 */
export function tryRenderServerToolBlock(
  block: Record<string, unknown>,
  key: React.Key,
): React.ReactNode | null {
  // ── Web Search Query ───────────────────────────────────────────────────
  if (block._serverToolUse) {
    const meta = block._serverToolUse as ServerToolUseMetadata;
    const query = meta.input?.query ?? "";
    if (query) {
      return <WebSearchQueryCard key={key} query={query} />;
    }
    // Unknown server tool — fall through to default text rendering
    return null;
  }

  // ── Web Search Results ─────────────────────────────────────────────────
  if (block._webSearchResult) {
    const meta = block._webSearchResult as WebSearchResultMetadata;
    const rawContent = Array.isArray(meta.content) ? meta.content : [];
    const results: WebSearchResult[] = rawContent
      .filter(
        (r): r is WebSearchResultBlock =>
          r.type === "web_search_result" &&
          typeof r.title === "string" &&
          typeof r.url === "string",
      )
      .map((r) => ({ title: r.title, url: r.url }));

    if (results.length > 0) {
      return <WebSearchResultsCard key={key} results={results} />;
    }
    return null;
  }

  // ── Future server tools go here ────────────────────────────────────────
  // Example:
  // if (block._codeExecution) { return <CodeExecutionCard ... />; }

  return null;
}
