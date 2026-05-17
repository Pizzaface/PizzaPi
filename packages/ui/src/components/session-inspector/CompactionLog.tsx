/** Table of compaction boundaries. */
import * as React from "react";
import type { CompactionBoundary } from "./types";
import { formatTokens } from "./formatters";

interface CompactionLogProps {
  boundaries: CompactionBoundary[];
}

export function CompactionLog({ boundaries }: CompactionLogProps) {
  const sorted = React.useMemo(() => {
    return [...boundaries].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
  }, [boundaries]);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No compactions recorded</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="py-2 px-2 text-left font-medium text-muted-foreground">Turn</th>
            <th className="py-2 px-2 text-right font-medium text-muted-foreground">Before</th>
            <th className="py-2 px-2 text-right font-medium text-muted-foreground">After</th>
            <th className="py-2 px-2 text-right font-medium text-muted-foreground">Saved</th>
            <th className="py-2 px-2 text-left font-medium text-muted-foreground hidden sm:table-cell">Time</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((b, i) => (
            <tr key={i} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
              <td className="py-2 px-2 tabular-nums">{b.turnIndex ?? "—"}</td>
              <td className="py-2 px-2 text-right tabular-nums">{formatTokens(b.beforeTokens)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{formatTokens(b.afterTokens)}</td>
              <td className="py-2 px-2 text-right tabular-nums text-green-600">
                {formatTokens(b.savingsTokens)}
              </td>
              <td className="py-2 px-2 text-muted-foreground hidden sm:table-cell">
                {b.timestamp ? new Date(b.timestamp).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
