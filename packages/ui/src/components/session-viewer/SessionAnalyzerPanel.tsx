/** Live collapsible panel for context & cache analysis inside SessionViewer. */
import * as React from "react";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import type { ContextBlock, SessionAnalysis } from "../session-inspector/types";
import { formatTokens, formatCurrency, formatPct } from "../session-inspector/formatters";

interface SessionAnalyzerPanelProps {
  runnerId: string;
  sessionId: string;
}

const ROLE_COLORS: Record<string, string> = {
  turn: "bg-blue-500/70 border-blue-500/40",
  system: "bg-slate-500/60 border-slate-500/40",
  compaction_summary: "bg-orange-500/70 border-orange-500/40",
  branch_summary: "bg-purple-500/70 border-purple-500/40",
  custom_message: "bg-teal-500/70 border-teal-500/40",
  separator: "bg-border border-border",
};

function roleColor(role?: string): string {
  return ROLE_COLORS[role ?? ""] ?? "bg-muted border-border";
}

function roleLabel(role?: string): string {
  if (!role) return "Unknown";
  return role.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function cn(...classes: (string | false | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

function Sparkline({ data, width = 400, height = 60 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${points.join(" L ")}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      <line x1="0" y1={height} x2={width} y2={height} stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} />
      <path
        d={path}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SessionAnalyzerPanel({ runnerId, sessionId }: SessionAnalyzerPanelProps) {
  const [analysis, setAnalysis] = React.useState<SessionAnalysis | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [hoveredBlock, setHoveredBlock] = React.useState<ContextBlock | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const fetchAnalysis = async () => {
      try {
        const res = await fetch(
          `/api/runners/${encodeURIComponent(runnerId)}/analysis/${encodeURIComponent(sessionId)}`,
          { headers: { Accept: "application/json" }, credentials: "include" },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data: SessionAnalysis = await res.json();
        if (!cancelled) {
          setAnalysis(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchAnalysis();
    const interval = setInterval(fetchAnalysis, 12_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runnerId, sessionId]);

  const sparklineData = React.useMemo(() => {
    if (!analysis?.contextBlocks?.length) return [];
    // Cumulative token counts for context growth
    let sum = 0;
    const blocks = [...analysis.contextBlocks];
    // Sort by turnIndex if available, otherwise keep order
    blocks.sort((a, b) => {
      const ta = a.turnIndex ?? -1;
      const tb = b.turnIndex ?? -1;
      return ta - tb;
    });
    return blocks.map((b) => {
      sum += b.tokenCount ?? 0;
      return sum;
    });
  }, [analysis]);

  const cacheHitRate = analysis?.cacheHitRate ?? null;
  const estSavings = analysis?.estimatedSavings ?? null;
  const peakTokens = analysis?.peakContextTokens ?? null;
  const compactionCount = analysis?.boundaries?.length ?? 0;

  // Collapsed summary line
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex items-center justify-between w-full px-3 py-1.5 text-xs border-b border-border bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 truncate">
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {!loading && error && (
            <span className="text-red-500">{error}</span>
          )}
          {!loading && !error && (
            <>
              <span className="text-muted-foreground">Cache: {formatPct(cacheHitRate)}</span>
              {estSavings != null && estSavings > 0 && (
                <span className="text-muted-foreground"> · Est. saved: {formatCurrency(estSavings)}</span>
              )}
              {peakTokens != null && (
                <span className="text-muted-foreground"> · Peak: {formatTokens(peakTokens)}</span>
              )}
              {compactionCount > 0 && (
                <span className="text-muted-foreground"> · {compactionCount} compaction{compactionCount !== 1 ? "s" : ""}</span>
              )}
              {(!analysis || !analysis.contextBlocks?.length) && <span className="text-muted-foreground">Waiting for first response…</span>}
            </>
          )}
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
      </button>
    );
  }

  return (
    <div className="border-b border-border bg-muted/20" style={{ maxHeight: 280 }}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex items-center justify-between w-full px-3 py-1.5 text-xs hover:bg-muted/40 transition-colors"
      >
        <span className="font-medium text-muted-foreground">Context &amp; Cache Analysis</span>
        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {/* Content */}
      <div className="px-3 pb-2 flex flex-col gap-2 overflow-auto">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {!loading && error && (
          <p className="text-xs text-red-500 py-1">{error}</p>
        )}
        {!loading && !error && (
          <>
            {/* CSS Treemap */}
            {analysis?.contextBlocks?.length ? (
              <TreemapInline
                blocks={analysis.contextBlocks}
                onHover={setHoveredBlock}
              />
            ) : (
              <p className="text-xs text-muted-foreground py-1">Waiting for first response…</p>
            )}

            {/* Tooltip */}
            {hoveredBlock && (
              <div className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5 bg-muted/40 inline-block">
                {roleLabel(hoveredBlock.role)}
                {hoveredBlock.turnIndex != null && ` · Turn ${hoveredBlock.turnIndex}`}
                {hoveredBlock.tokenCount != null && ` · ${formatTokens(hoveredBlock.tokenCount)} tokens`}
                {hoveredBlock.cost != null && ` · ${formatCurrency(hoveredBlock.cost)}`}
              </div>
            )}

            {/* SVG Sparkline */}
            {sparklineData.length > 1 && (
              <div className="mt-1">
                <Sparkline data={sparklineData} />
              </div>
            )}

            {/* Disclaimer */}
            <p className="text-[10px] text-muted-foreground/60 italic">
              Approximate — token counts are estimates from the provider.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Inline CSS treemap for the live panel. */
function TreemapInline({
  blocks,
  onHover,
}: {
  blocks: ContextBlock[];
  onHover: (block: ContextBlock | null) => void;
}) {
  const totalTokens = React.useMemo(() => {
    return blocks.reduce((sum, b) => sum + (b.tokenCount ?? 0), 0);
  }, [blocks]);

  if (totalTokens === 0) return null;

  const targetRowTokens = totalTokens / Math.max(Math.ceil(blocks.length / 4), 1);
  const rows: ContextBlock[][] = [];
  let currentRow: ContextBlock[] = [];
  let rowSum = 0;

  for (const block of blocks) {
    const t = block.tokenCount ?? 0;
    if (rowSum + t > targetRowTokens * 1.5 && currentRow.length > 0) {
      rows.push(currentRow);
      currentRow = [block];
      rowSum = t;
    } else {
      currentRow.push(block);
      rowSum += t;
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);

  return (
    <div className="flex flex-col gap-0.5 w-full" style={{ height: 120 }}>
      {rows.map((row, ri) => {
        const rowTotal = row.reduce((s, b) => s + (b.tokenCount ?? 0), 0);
        return (
          <div key={ri} className="flex gap-0.5 w-full flex-1 min-h-0">
            {row.map((block, bi) => {
              const pct = rowTotal > 0 ? ((block.tokenCount ?? 0) / rowTotal) * 100 : 0;
              const isSeparator = block.role === "separator";
              return (
                <div
                  key={bi}
                  className={cn(
                    "relative rounded-sm border overflow-hidden transition-opacity hover:opacity-90 cursor-default flex items-end justify-start px-1 py-0.5 min-h-[1rem]",
                    roleColor(block.role),
                    isSeparator ? "min-w-[2px] flex-shrink-0 max-w-[2px] px-0" : "flex-1",
                  )}
                  style={isSeparator ? {} : { flexBasis: `${pct}%` }}
                  onMouseEnter={() => onHover(block)}
                  onMouseLeave={() => onHover(null)}
                  title={`${roleLabel(block.role)}${block.turnIndex != null ? ` · Turn ${block.turnIndex}` : ""}${block.tokenCount != null ? ` · ${block.tokenCount.toLocaleString()} tokens` : ""}`}
                >
                  {!isSeparator && pct > 10 && (
                    <span className="text-[9px] font-medium text-white/90 truncate leading-none">
                      {roleLabel(block.role)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
