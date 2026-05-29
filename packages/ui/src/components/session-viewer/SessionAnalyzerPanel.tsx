/** Live context & cache analysis panel inside SessionViewer. */
import * as React from "react";
import { BarChart3 } from "lucide-react";
import { CombinedPanel } from "@/components/CombinedPanel";
import { Treemap } from "../session-inspector/Treemap";
import type { ContextBlock, SessionAnalysis } from "../session-inspector/types";
import { formatTokens, formatCurrency, formatPct } from "../session-inspector/formatters";

interface SessionAnalyzerPanelProps {
  analysis: SessionAnalysis | null;
  runnerId?: string | null;
  sessionId?: string | null;
  onClose?: () => void;
}

interface SessionAnalyzerBodyProps {
  analysis: SessionAnalysis | null;
  runnerId?: string | null;
  sessionId?: string | null;
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/30 px-3 py-2.5 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {detail && (
        <div className="mt-0.5 text-[10px] text-muted-foreground/80 truncate">
          {detail}
        </div>
      )}
    </div>
  );
}

type SparklineMarker = { index: number; label?: string };

function Sparkline({
  data,
  markers = [],
  width = 400,
  height = 96,
}: {
  data: number[];
  markers?: SparklineMarker[];
  width?: number;
  height?: number;
}) {
  const gradientId = React.useId();
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const topPad = 12;
  const bottomPad = 12;
  const usableHeight = height - topPad - bottomPad;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - bottomPad - ((v - min) / range) * usableHeight;
    return { x, y };
  });
  const linePath = `M ${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")}`;
  const areaPath = `${linePath} L ${width} ${height - bottomPad} L 0 ${height - bottomPad} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#5b8cff" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#5b8cff" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {[0.25, 0.5, 0.75].map((y) => (
        <line
          key={y}
          x1="0"
          y1={topPad + usableHeight * y}
          x2={width}
          y2={topPad + usableHeight * y}
          stroke="currentColor"
          strokeOpacity={0.07}
          strokeWidth={1}
        />
      ))}
      <line
        x1="0"
        y1={height - bottomPad}
        x2={width}
        y2={height - bottomPad}
        stroke="currentColor"
        strokeOpacity={0.12}
        strokeWidth={1}
      />

      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke="#5b8cff"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {markers.map((marker, index) => {
        const point = points[marker.index];
        if (!point) return null;
        return (
          <g key={`${marker.index}-${index}`}>
            <line
              x1={point.x}
              y1={topPad}
              x2={point.x}
              y2={height - bottomPad}
              stroke="#f2c65f"
              strokeOpacity={0.65}
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <circle cx={point.x} cy={point.y} r={2.8} fill="#f2c65f" />
          </g>
        );
      })}
    </svg>
  );
}

export function SessionAnalyzerBody({ analysis, runnerId, sessionId }: SessionAnalyzerBodyProps) {
  const [hoveredBlock, setHoveredBlock] = React.useState<ContextBlock | null>(null);
  const [fetchedAnalysis, setFetchedAnalysis] = React.useState<SessionAnalysis | null>(null);

  React.useEffect(() => {
    if (!runnerId || !sessionId) {
      setFetchedAnalysis(null);
      return;
    }

    let cancelled = false;
    setFetchedAnalysis(null);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/analysis/${encodeURIComponent(sessionId)}`, {
      headers: { Accept: "application/json" },
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json() as SessionAnalysis;
      })
      .then((nextAnalysis) => {
        if (!cancelled) setFetchedAnalysis(nextAnalysis);
      })
      .catch(() => {
        if (!cancelled) setFetchedAnalysis(null);
      });

    return () => { cancelled = true; };
  }, [runnerId, sessionId]);

  const effectiveAnalysis = analysis ?? fetchedAnalysis;

  const growthPoints = React.useMemo(() => {
    if (!effectiveAnalysis?.blocks?.length) return [];
    const turnBlocks = effectiveAnalysis.blocks
      .filter((block) => block.turnIndex >= 0)
      .sort((a, b) => a.turnIndex - b.turnIndex);

    let sum = 0;
    return turnBlocks.map((block) => {
      const usageInput = block.usage?.input;
      if (typeof usageInput === "number") {
        sum = usageInput;
      } else {
        sum = Math.max(0, sum + (block.rawTokenDelta ?? block.tokens ?? 0));
      }
      return { value: sum, block };
    });
  }, [effectiveAnalysis]);

  const compactionMarkers = React.useMemo(() => {
    if (!effectiveAnalysis?.compactions?.length || !growthPoints.length) return [];
    const indexByEntryId = new Map(growthPoints.map((point, index) => [point.block.entryId, index] as const));
    return effectiveAnalysis.compactions
      .map((boundary) => {
        const index = indexByEntryId.get(boundary.entryId);
        return index == null ? null : { index };
      })
      .filter((marker): marker is SparklineMarker => !!marker);
  }, [effectiveAnalysis, growthPoints]);

  const sortedBlocks = React.useMemo(() => {
    const blocks = effectiveAnalysis?.blocks ?? [];
    return [...blocks].sort((a, b) => {
      if (a.turnIndex < 0 && b.turnIndex >= 0) return -1;
      if (b.turnIndex < 0 && a.turnIndex >= 0) return 1;
      return a.turnIndex - b.turnIndex;
    });
  }, [effectiveAnalysis?.blocks]);

  const cacheHitRate = effectiveAnalysis?.summary?.cacheHitRate ?? null;
  const estSavings = effectiveAnalysis?.summary?.estimatedCacheSavings ?? null;
  const peakTokens = effectiveAnalysis?.summary?.peakContextUsage ?? null;
  const compactionCount = effectiveAnalysis?.summary?.compactionCount ?? effectiveAnalysis?.compactions?.length ?? 0;
  const totalTokens = effectiveAnalysis?.summary?.totalTokens ?? null;
  const tokensFreedByCompaction = effectiveAnalysis?.summary?.tokensFreedByCompaction ?? null;
  const contextWindow = effectiveAnalysis?.activeModel?.contextWindow ?? null;
  const contextUtilization = effectiveAnalysis?.summary?.contextUtilization ?? null;
  const effectiveContextUtilization = contextUtilization ?? (
    peakTokens != null && contextWindow ? peakTokens / contextWindow : null
  );
  const latestGrowth = growthPoints.length ? growthPoints[growthPoints.length - 1]!.value : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto px-3 py-3">
      {!effectiveAnalysis ? (
        <p className="text-xs text-muted-foreground py-1">Waiting for first response…</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Cache hit"
              value={formatPct(cacheHitRate)}
              detail={estSavings != null && estSavings > 0 ? `Est. saved ${formatCurrency(estSavings)}` : null}
            />
            <MetricCard
              label="Peak context"
              value={formatTokens(peakTokens)}
              detail={contextWindow ? `of ${formatTokens(contextWindow)}` : null}
            />
            <MetricCard
              label="Compactions"
              value={String(compactionCount)}
              detail={tokensFreedByCompaction != null ? `Freed ${formatTokens(tokensFreedByCompaction)}` : null}
            />
            <MetricCard
              label="Context use"
              value={formatPct(effectiveContextUtilization)}
              detail={totalTokens != null ? `Total ${formatTokens(totalTokens)}` : null}
            />
          </div>

          <section className="rounded-xl border border-border/60 bg-background/30 p-3 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">Growth</div>
                <h3 className="text-sm font-medium text-foreground">Context over time</h3>
              </div>
              <div className="flex flex-wrap justify-end gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-full border border-border/60 bg-muted/20 px-2.5 py-1">Peak {formatTokens(peakTokens)}</span>
                <span className="rounded-full border border-border/60 bg-muted/20 px-2.5 py-1">
                  {compactionCount} compaction{compactionCount !== 1 ? "s" : ""}
                </span>
              </div>
            </div>

            <div className="mt-3">
              <Sparkline
                data={growthPoints.map((point) => point.value)}
                markers={compactionMarkers}
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
              <span>Growth is cumulative context size. Amber markers show compactions.</span>
              <span>{latestGrowth != null ? `${formatTokens(latestGrowth)} total` : ""}</span>
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-background/30 p-3 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">Blocks</div>
                <h3 className="text-sm font-medium text-foreground">Largest context pieces</h3>
              </div>
              <span className="text-[11px] text-muted-foreground">{effectiveAnalysis.blocks?.length ?? 0} items</span>
            </div>

            <div className="mt-3">
              {sortedBlocks.length ? (
                <Treemap
                  blocks={sortedBlocks}
                  onHover={(block) => setHoveredBlock(block)}
                />
              ) : (
                <p className="text-xs text-muted-foreground py-1">Waiting for first response…</p>
              )}
            </div>

            {hoveredBlock && (
              <div className="mt-3 text-xs text-muted-foreground border rounded-md p-2 bg-muted/30">
                <span className="font-medium text-foreground">
                  {hoveredBlock.title ?? hoveredBlock.role ?? "Block"}
                </span>
                {hoveredBlock.turnIndex >= 0 && (
                  <span> · Turn {hoveredBlock.turnIndex}</span>
                )}
                {hoveredBlock.tokens != null && (
                  <span> · {formatTokens(hoveredBlock.tokens)} tokens</span>
                )}
                {hoveredBlock.usage?.cost?.total != null && (
                  <span> · {formatCurrency(hoveredBlock.usage.cost.total)}</span>
                )}
              </div>
            )}
          </section>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
            <span>Approximate — token counts are provider estimates.</span>
            <span>Amber markers indicate a compaction boundary.</span>
          </div>
        </>
      )}
    </div>
  );
}

export function SessionAnalyzerPanel({ analysis, runnerId, sessionId, onClose }: SessionAnalyzerPanelProps) {
  return (
    <CombinedPanel
      tabs={[
        {
          id: "context-cache-analysis",
          label: "Context & Cache Analysis",
          icon: <BarChart3 className="size-3.5" />,
          onClose,
          content: <SessionAnalyzerBody analysis={analysis} runnerId={runnerId} sessionId={sessionId} />,
        },
      ]}
      activeTabId="context-cache-analysis"
      onActiveTabChange={() => {}}
      position="center-bottom"
      className="h-[320px] overflow-hidden border-b border-border bg-muted/20"
    />
  );
}
