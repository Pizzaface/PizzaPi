/**
 * Shared chart theme utilities for the Usage Dashboard.
 *
 * Provides theme-aware colors (via CSS variables), a reusable custom tooltip
 * style object, and common formatters so every chart looks consistent.
 */

// ── Theme-aware chart colors ────────────────────────────────────────────────
// These read the CSS custom properties set in style.css (:root / .dark).
// Recharts needs concrete hex/rgb values at render time, so we resolve them
// from the computed style of the document element.

function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolve a CSS variable to a usable color string for Recharts. */
export function chartColor(index: 1 | 2 | 3 | 4 | 5): string {
  return cssVar(`--chart-${index}`) || FALLBACK_COLORS[index - 1];
}

const FALLBACK_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#ef4444", // red
];

/**
 * Semantic color map for the token-type / cost-type breakdown charts.
 * Each key maps to a distinct, non-overlapping hue so there's no
 * accidental false associations across charts.
 */
export const COST_COLORS = {
  input: "#3b82f6",     // blue-500
  output: "#f97316",    // orange-500  (was red — now distinct from destructive)
  cacheRead: "#8b5cf6", // violet-500
  cacheWrite: "#14b8a6", // teal-500   (was amber — now won't clash with chart-4)
};

/** 10-color categorical palette for the model pie chart. */
export const PIE_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444",
  "#ec4899", "#06b6d4", "#14b8a6", "#f97316", "#6366f1",
];

// ── Tooltip styles ──────────────────────────────────────────────────────────

/** Inline style object for the custom tooltip wrapper div. */
export const tooltipContentStyle: React.CSSProperties = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: "0.75rem",
  lineHeight: "1.125rem",
  padding: "6px 10px",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  minWidth: "140px",
  maxWidth: "220px",
};

export const tooltipLabelStyle: React.CSSProperties = {
  color: "var(--popover-foreground)",
  fontWeight: 600,
  marginBottom: "2px",
  fontSize: "0.75rem",
};

export const tooltipItemStyle: React.CSSProperties = {
  color: "var(--popover-foreground)",
  padding: "1px 0",
  fontSize: "0.6875rem",
};

// ── Formatters ──────────────────────────────────────────────────────────────

export function formatCurrency(value: number): string {
  if (value === 0) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00"); // force local parse
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Recharts cursor style ───────────────────────────────────────────────────

/** Semi-transparent cursor overlay for bar/area charts. */
export const chartCursorStyle = {
  fill: "var(--muted)",
  fillOpacity: 0.4,
};
