/** Sortable table of context blocks / turns. */
import * as React from "react";
import type { ContextBlock } from "./types";
import { formatTokens, formatCurrency, formatPct } from "./formatters";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

type SortKey = "turnIndex" | "role" | "tokens" | "cost" | "cache";
type SortDir = "asc" | "desc";

const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "turnIndex", dir: "asc" };

interface Column {
  key: SortKey;
  label: string;
  align: "left" | "right";
  sortValue: (b: ContextBlock) => string | number;
  render: (b: ContextBlock) => React.ReactNode;
}

const COLUMNS: Column[] = [
  {
    key: "turnIndex",
    label: "Turn",
    align: "left",
    sortValue: (b) => b.turnIndex ?? -1,
    render: (b) => (b.turnIndex != null ? b.turnIndex : "—"),
  },
  {
    key: "role",
    label: "Role",
    align: "left",
    sortValue: (b) => b.role ?? "",
    render: (b) => (b.title ?? (b.role ? b.role.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—")),
  },
  {
    key: "tokens",
    label: "Tokens",
    align: "right",
    sortValue: (b) => b.tokens ?? -1,
    render: (b) => formatTokens(b.tokens),
  },
  {
    key: "cost",
    label: "Cost",
    align: "right",
    sortValue: (b) => b.usage?.cost?.total ?? -1,
    render: (b) => formatCurrency(b.usage?.cost?.total),
  },
  {
    key: "cache",
    label: "Cache",
    align: "right",
    sortValue: (b) => {
      const input = b.usage?.input ?? 0;
      const cacheRead = b.usage?.cacheRead ?? 0;
      return input + cacheRead > 0 ? cacheRead / (input + cacheRead) : -1;
    },
    render: (b) => {
      const input = b.usage?.input ?? 0;
      const cacheRead = b.usage?.cacheRead ?? 0;
      return formatPct(input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null);
    },
  },
];

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
  return dir === "asc" ? (
    <ArrowUp className="h-3 w-3" />
  ) : (
    <ArrowDown className="h-3 w-3" />
  );
}

interface TurnListProps {
  blocks: ContextBlock[];
}

export function TurnList({ blocks }: TurnListProps) {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>(DEFAULT_SORT);

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  const sorted = React.useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key)!;
    const multiplier = sort.dir === "asc" ? 1 : -1;
    return [...blocks].sort((a, b) => {
      // When sorting by turnIndex: put negative-index blocks first
      if (sort.key === "turnIndex") {
        if (a.turnIndex < 0 && b.turnIndex >= 0) return -1;
        if (b.turnIndex < 0 && a.turnIndex >= 0) return 1;
      }
      const va = col.sortValue(a);
      const vb = col.sortValue(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * multiplier;
      }
      return String(va).localeCompare(String(vb)) * multiplier;
    });
  }, [blocks, sort]);

  if (blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">No turn data available</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/30">
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={`py-2 px-2 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors ${
                  col.align === "right" ? "text-right" : "text-left"
                }`}
                onClick={() => toggleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.align === "right" && (
                    <SortIcon active={sort.key === col.key} dir={sort.dir} />
                  )}
                  {col.label}
                  {col.align === "left" && (
                    <SortIcon active={sort.key === col.key} dir={sort.dir} />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((block, i) => (
            <tr
              key={i}
              className="border-b last:border-0 hover:bg-muted/50 transition-colors"
              title={block.entryId ?? undefined}
            >
              {COLUMNS.map((col) => (
                <td
                  key={col.key}
                  className={`py-2 px-2 ${
                    col.align === "right" ? "text-right tabular-nums" : "truncate max-w-[200px]"
                  }`}
                >
                  {col.render(block)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
