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
  separator: "#94a3b8",
};

const ROLE_STROKE: Record<string, string> = {
  turn: "#2563eb",
  system: "#475569",
  compaction_summary: "#ea580c",
  branch_summary: "#7e22ce",
  custom_message: "#0d9488",
  separator: "#64748b",
};

function roleFill(role?: string): string {
  return ROLE_FILL[role ?? ""] ?? "#94a3b8";
}

function roleStroke(role?: string): string {
  return ROLE_STROKE[role ?? ""] ?? "#64748b";
}

function roleLabel(role?: string): string {
  if (!role) return "Unknown";
  return role.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function Treemap({ blocks, width = 600, height = 240, onHover }: TreemapProps) {
  const totalTokens = React.useMemo(() => {
    return blocks.reduce((sum, b) => sum + (b.tokenCount ?? 0), 0);
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

  // Greedy row-based layout within SVG
  const targetRowTokens = totalTokens / Math.max(Math.ceil(blocks.length / 3), 1);
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

  const rowHeights = rows.map((row) => {
    const rowTokens = row.reduce((s, b) => s + (b.tokenCount ?? 0), 0);
    return (rowTokens / totalTokens) * height;
  });

  const rects: { block: ContextBlock; x: number; y: number; w: number; h: number }[] = [];
  let y = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const h = rowHeights[ri];
    const rowTokens = row.reduce((s, b) => s + (b.tokenCount ?? 0), 0);
    let x = 0;
    for (const block of row) {
      const w = rowTokens > 0 ? ((block.tokenCount ?? 0) / rowTokens) * width : 0;
      rects.push({ block, x, y, w, h });
      x += w;
    }
    y += h;
  }

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto rounded-md border border-border bg-muted/20">
        {rects.map((r, i) => {
          const stroke = roleStroke(r.block.role);
          const fill = roleFill(r.block.role);
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
              strokeWidth={isSeparator ? 0.5 : 1}
              opacity={isSeparator ? 0.5 : 0.85}
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
