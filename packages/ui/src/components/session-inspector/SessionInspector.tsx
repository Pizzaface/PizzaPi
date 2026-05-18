/** Full-page session inspector with treemap + tabbed panels. */
import * as React from "react";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTokens, formatCurrency, formatPct } from "./formatters";
import type { ContextBlock, SessionAnalysis } from "./types";
import { Treemap } from "./Treemap";
import { CostBreakdown } from "./CostBreakdown";
import { CompactionLog } from "./CompactionLog";
import { TurnList } from "./TurnList";

interface SessionInspectorProps {
  runnerId: string;
  sessionId: string;
  sessionName?: string | null;
  onBack: () => void;
}

type TabKey = "cost" | "compactions" | "turns" | "models";

export function SessionInspector({
  runnerId,
  sessionId,
  sessionName,
  onBack,
}: SessionInspectorProps) {
  const [analysis, setAnalysis] = React.useState<SessionAnalysis | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<TabKey>("cost");
  const [hoveredBlock, setHoveredBlock] = React.useState<ContextBlock | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const fetchAnalysis = async () => {
      setLoading(true);
      setError(null);
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
        if (!cancelled) setAnalysis(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchAnalysis();
    return () => { cancelled = true; };
  }, [runnerId, sessionId]);

  // Sort blocks: negative indices (cached context) first, then positive turns
  const sortedBlocks = React.useMemo(() => {
    const blocks = analysis?.blocks ?? [];
    if (blocks.length === 0) return blocks;
    return [...blocks].sort((a, b) => {
      if (a.turnIndex < 0 && b.turnIndex >= 0) return -1;
      if (b.turnIndex < 0 && a.turnIndex >= 0) return 1;
      return a.turnIndex - b.turnIndex;
    });
  }, [analysis?.blocks]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Loading session analysis…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col flex-1 p-6 gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="w-fit">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex items-center gap-3 p-4 border border-red-500/30 bg-red-500/5 rounded-lg">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <div>
            <h3 className="font-medium text-red-900 dark:text-red-200">Error loading analysis</h3>
            <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="flex flex-col flex-1 p-6 gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="w-fit">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <p className="text-sm text-muted-foreground">No analysis data available for this session.</p>
      </div>
    );
  }

  const totalCost = analysis?.summary?.totalCost ?? 0;
  const cacheHitRate = analysis?.summary?.cacheHitRate ?? null;
  const estSavings = analysis?.summary?.estimatedCacheSavings ?? null;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 px-2">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">
            {sessionName || `Session ${sessionId.slice(0, 8)}`}
          </h2>
          <p className="text-xs text-muted-foreground">
            {analysis.modelsUsed?.length
              ? analysis.modelsUsed.map((m) => m.id).filter(Boolean).join(", ")
              : "Model info unavailable"}
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Cache Hit</div>
            <div className="font-semibold tabular-nums">{formatPct(cacheHitRate)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total Cost</div>
            <div className="font-semibold tabular-nums">{formatCurrency(totalCost)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Est. Saved</div>
            <div className="font-semibold tabular-nums text-green-600">{formatCurrency(estSavings)}</div>
          </div>
        </div>
      </div>

      {/* Main content */}
      {sortedBlocks.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          No context blocks available
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row flex-1 overflow-hidden">
          {/* Left: Treemap */}
          <div className="flex-1 p-4 overflow-auto min-h-0 flex flex-col gap-2">
            <Treemap
              blocks={sortedBlocks}
              onHover={(block) => setHoveredBlock(block)}
            />
            {hoveredBlock && (
              <div className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/30">
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
          </div>

          {/* Right: Tabs */}
          <div className="lg:w-[40%] border-t lg:border-t-0 lg:border-l border-border flex flex-col min-h-0">
            <div className="flex border-b">
              {([
                { key: "cost", label: "Cost" },
                { key: "compactions", label: "Compactions" },
                { key: "turns", label: "Turns" },
                { key: "models", label: "Models" },
              ] as { key: TabKey; label: string }[]).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`px-3 py-2 text-xs font-medium transition-colors ${
                    activeTab === t.key
                      ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-auto p-4 min-h-0">
              {activeTab === "cost" && (
                <CostBreakdown models={analysis.modelsUsed ?? []} />
              )}
              {activeTab === "compactions" && (
                <CompactionLog boundaries={analysis.compactions ?? []} />
              )}
              {activeTab === "turns" && (
                <TurnList blocks={sortedBlocks} />
              )}
              {activeTab === "models" && (
                <div className="space-y-2">
                  {(analysis.modelsUsed ?? []).length === 0 && (
                    <p className="text-sm text-muted-foreground">Model data unavailable</p>
                  )}
                  {(analysis.modelsUsed ?? []).map((m) => (
                    <div
                      key={m.id ?? ""}
                      className="flex flex-col gap-0.5 border rounded-md p-2 text-sm"
                    >
                      <div className="font-medium">{m.id ?? "Unknown model"}</div>
                      <div className="text-xs text-muted-foreground">
                        Turns: {m.turns ?? "—"} · Cost: {formatCurrency(m.totalCost)} · Cache hit: {formatPct(m.cacheHitRate)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
