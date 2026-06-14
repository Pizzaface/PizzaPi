/**
 * SVG treemap showing context blocks proportional to token count,
 * color-coded by block role.
 */
import * as React from "react";
import type { ContextBlock } from "./types";

interface TreemapProps {
  blocks: ContextBlock[];
  width?: number;
  height?: number;
  onHover?: (block: ContextBlock | null, x?: number, y?: number) => void;
}

const ROLE_FILL: Record<string, string> = {
  turn: "#3b82f6",
  system: "#64748b",
  compaction_summary: "#f97316",
  branch_summary: "#a855f7",
  custom_message: "#14b8a6",
  "context:builtin-prompt": "#475569",
  "context:global-rules": "#4338ca",
  "context:project-rules": "#7c3aed",
  "context:append-prompt": "#b45309",
  "context:skill": "#059669",
  "context:plugin": "#0891b2",
  separator: "#94a3b8",
};

const ROLE_STROKE: Record<string, string> = {
  turn: "#2563eb",
  system: "#475569",
  compaction_summary: "#ea580c",
  branch_summary: "#7e22ce",
  custom_message: "#0d9488",
  "context:builtin-prompt": "#334155",
  "context:global-rules": "#3730a3",
  "context:project-rules": "#6d28d9",
  "context:append-prompt": "#92400e",
  "context:skill": "#047857",
  "context:plugin": "#0e7490",
  separator: "#64748b",
};

function blockFill(block: ContextBlock): string {
  return ROLE_FILL[block.role ?? ""] ?? "#94a3b8";
}

function blockStroke(block: ContextBlock): string {
  return ROLE_STROKE[block.role ?? ""] ?? "#64748b";
}

export function Treemap({ blocks, width = 600, height = 240, onHover }: TreemapProps) {
  const totalTokens = React.useMemo(() => {
    return blocks.reduce((sum, b) => sum + (b.tokens ?? 0), 0);
  }, [blocks]);

  if (totalTokens === 0 && blocks.length > 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Token counts not available
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No context blocks
      </div>
    );
  }

  // Greedy row-based layout within SVG. Keep row count low so the
  // smallest regions stay visible instead of collapsing into hairlines.
  const desiredRows = blocks.length <= 1
    ? 1
    : Math.min(5, Math.max(2, Math.ceil(blocks.length / 48)));
  const targetRowTokens = totalTokens / desiredRows;
  const rows: ContextBlock[][] = [];
  let currentRow: ContextBlock[] = [];
  let rowSum = 0;

  for (const block of blocks) {
    const t = block.tokens ?? 0;
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

  const rawRowHeights = rows.map((row) => {
    const rowTokens = row.reduce((s, b) => s + (b.tokens ?? 0), 0);
    return (rowTokens / totalTokens) * height;
  });
  const minRowHeight = Math.min(18, height / rows.length);
  const smallRows = rawRowHeights.filter((h) => h < minRowHeight).length;
  const largeRowsTotal = rawRowHeights
    .filter((h) => h >= minRowHeight)
    .reduce((sum, h) => sum + h, 0);
  const remainingHeight = height - (smallRows * minRowHeight);
  const rowHeights = remainingHeight > 0 && largeRowsTotal > 0
    ? rawRowHeights.map((h) => h < minRowHeight ? minRowHeight : (h / largeRowsTotal) * remainingHeight)
    : rows.map(() => height / rows.length);

  const rects: { block: ContextBlock; x: number; y: number; w: number; h: number }[] = [];
  let y = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const h = rowHeights[ri];
    const rowTokens = row.reduce((s, b) => s + (b.tokens ?? 0), 0);
    let x = 0;
    for (const block of row) {
      const w = rowTokens > 0 ? ((block.tokens ?? 0) / rowTokens) * width : 0;
      rects.push({ block, x, y, w, h });
      x += w;
    }
    y += h;
  }

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto rounded-md border border-border bg-muted/20">
        {rects.map((r, i) => {
          const stroke = blockStroke(r.block);
          const fill = blockFill(r.block);
          const isSeparator = r.block.role === "separator";
          return (
            <rect
              key={i}
              x={r.x + 0.5}
              y={r.y + 0.5}
              width={Math.max(r.w - 1, 0)}
              height={Math.max(r.h - 1, 0)}
              fill={fill}
              stroke={stroke}
              strokeWidth={isSeparator ? 0.5 : 1.5}
              opacity={isSeparator ? 0.45 : 0.95}
              rx={isSeparator ? 0 : 2}
              className="cursor-default transition-opacity hover:opacity-100"
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onHover?.(r.block, rect.left + rect.width / 2, rect.top);
              }}
              onMouseLeave={() => onHover?.(null)}
            />
          );
        })}
      </svg>
    </div>
  );
}
