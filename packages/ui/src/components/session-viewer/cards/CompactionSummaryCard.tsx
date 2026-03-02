import * as React from "react";
import { MessageResponse } from "@/components/ai-elements/message";

interface CompactionSummaryCardProps {
  summary: string;
  tokensBefore?: number;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function CompactionSummaryCard({ summary, tokensBefore }: CompactionSummaryCardProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
      >
        <span className="shrink-0">📋</span>
        <span className="font-medium">Context compacted</span>
        {typeof tokensBefore === "number" && tokensBefore > 0 && (
          <span className="text-muted-foreground/70">
            · {formatTokenCount(tokensBefore)} tokens summarized
          </span>
        )}
        <span className="ml-auto text-muted-foreground/50">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/40">
          <div className="pt-2 text-sm">
            <MessageResponse>{summary}</MessageResponse>
          </div>
        </div>
      )}
    </div>
  );
}
