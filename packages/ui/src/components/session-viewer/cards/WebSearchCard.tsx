import * as React from "react";
import { SearchIcon, ExternalLinkIcon, GlobeIcon } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  StatusPill,
} from "../../ui/tool-card";

// ── Types ────────────────────────────────────────────────────────────────────

/** A single web search result with title and URL. */
export interface WebSearchResult {
  title: string;
  url: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a readable hostname from a URL (e.g. "docs.github.com"). */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Allowlist URL schemes for web search result links.
 * Blocks javascript:, data:, vbscript:, and other dangerous schemes.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/** Google's public favicon service — returns a 16×16 icon for any domain. */
function faviconUrl(url: string): string {
  const domain = extractDomain(url);
  return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(domain)}`;
}

// ── Query Card ───────────────────────────────────────────────────────────────

/**
 * Compact inline card showing the web search query that was sent.
 */
export function WebSearchQueryCard({ query }: { query: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-400">
      <SearchIcon className="size-3.5 shrink-0 text-blue-400" />
      <span>
        Searched for{" "}
        <span className="font-medium text-zinc-200">&ldquo;{query}&rdquo;</span>
      </span>
    </div>
  );
}

// ── Results Card ─────────────────────────────────────────────────────────────

/**
 * Card listing web search results with favicons, titles, and domain badges.
 */
export function WebSearchResultsCard({
  results,
}: {
  results: WebSearchResult[];
}) {
  if (results.length === 0) return null;

  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2">
        <ToolCardTitle
          icon={<GlobeIcon className="size-3.5 shrink-0 text-blue-400" />}
        >
          <span className="text-sm font-medium text-zinc-300">
            Search Results
          </span>
        </ToolCardTitle>
        <ToolCardActions>
          <StatusPill variant="success">
            {results.length} {results.length === 1 ? "result" : "results"}
          </StatusPill>
        </ToolCardActions>
      </ToolCardHeader>

      <ul className="divide-y divide-zinc-800/60">
        {results.map((result, idx) => (
          <li key={`${result.url}-${idx}`}>
            <a
              href={isSafeUrl(result.url) ? result.url : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-900/60 transition-colors group"
            >
              {/* Favicon */}
              <img
                src={faviconUrl(result.url)}
                alt=""
                width={16}
                height={16}
                className="size-4 shrink-0 rounded-sm"
                loading="lazy"
                // Hide broken favicons gracefully
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />

              {/* Title + domain */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs font-medium text-zinc-200 truncate group-hover:text-blue-400 transition-colors">
                  {result.title}
                </span>
                <span className="text-[11px] text-zinc-500 truncate">
                  {extractDomain(result.url)}
                </span>
              </div>

              {/* External link icon */}
              <ExternalLinkIcon className="size-3 shrink-0 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
            </a>
          </li>
        ))}
      </ul>
    </ToolCardShell>
  );
}
