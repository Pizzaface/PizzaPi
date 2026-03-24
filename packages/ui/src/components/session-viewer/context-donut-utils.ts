import type { TokenUsage } from "../../lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────
// Pure functions extracted from ContextDonut so tests can import them without
// pulling in React / aliased UI component dependencies.

/** Compute the percentage of context window used (0–100, clamped).
 *  Returns null if contextTokens is not available (cumulative input is not
 *  a valid proxy — it can be wildly inflated after compaction). */
export function contextPercent(tokenUsage: TokenUsage, contextWindow: number): number | null {
  if (contextWindow <= 0) return null;
  const tokens = tokenUsage.contextTokens;
  if (tokens == null || tokens <= 0) return null;
  const pct = (tokens / contextWindow) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Pick a semantic color based on usage percentage. */
export function donutColor(pct: number): string {
  if (pct >= 85) return "text-red-500 dark:text-red-400";
  if (pct >= 65) return "text-amber-500 dark:text-amber-400";
  return "text-emerald-500 dark:text-emerald-400";
}

/** Pick the SVG stroke color (raw hex-ish class for the arc). */
export function donutStroke(pct: number): string {
  if (pct >= 85) return "stroke-red-500 dark:stroke-red-400";
  if (pct >= 65) return "stroke-amber-500 dark:stroke-amber-400";
  return "stroke-emerald-500 dark:stroke-emerald-400";
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}
