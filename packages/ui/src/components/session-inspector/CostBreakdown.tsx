/** Simple horizontal bar chart for model cost breakdown. */
import * as React from "react";
import type { ModelStats } from "./types";
import { formatCurrency } from "./formatters";

interface CostBreakdownProps {
  models: ModelStats[];
}

export function CostBreakdown({ models }: CostBreakdownProps) {
  const sorted = React.useMemo(() => {
    return [...models].sort((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0));
  }, [models]);

  const maxCost = React.useMemo(() => {
    return sorted.reduce((max, m) => Math.max(max, m.totalCost ?? 0), 0);
  }, [sorted]);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">Cost data unavailable</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {sorted.map((m) => {
        const cost = m.totalCost ?? 0;
        const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;
        return (
          <div key={m.id ?? "unknown"} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-xs">
              <span className="truncate max-w-[70%] font-medium">{m.id ?? "Unknown model"}</span>
              <span className="tabular-nums text-muted-foreground">{formatCurrency(cost)}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
