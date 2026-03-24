import React, { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "./chart-theme";
import type { UsageData } from "./types";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

type Session = UsageData["recentSessions"][number];

type SortKey = "name" | "project" | "model" | "cost" | "messages" | "startedAt";
type SortDir = "asc" | "desc";

const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "startedAt", dir: "desc" };

interface Column {
  key: SortKey;
  label: string;
  align: "left" | "right";
  render: (s: Session) => React.ReactNode;
  sortValue: (s: Session) => string | number;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatAbsoluteTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const COLUMNS: Column[] = [
  {
    key: "name",
    label: "Session",
    align: "left",
    render: (s) => s.sessionName || `Session ${s.id.slice(0, 8)}`,
    sortValue: (s) => (s.sessionName || s.id).toLowerCase(),
  },
  {
    key: "project",
    label: "Project",
    align: "left",
    render: (s) => s.projectShort,
    sortValue: (s) => s.projectShort.toLowerCase(),
  },
  {
    key: "model",
    label: "Model",
    align: "left",
    render: (s) => s.primaryModel,
    sortValue: (s) => s.primaryModel.toLowerCase(),
  },
  {
    key: "startedAt",
    label: "Started",
    align: "left",
    render: (s) => (
      <span title={formatAbsoluteTime(s.startedAt)}>
        {formatRelativeTime(s.startedAt)}
      </span>
    ),
    sortValue: (s) => new Date(s.startedAt).getTime(),
  },
  {
    key: "cost",
    label: "Cost",
    align: "right",
    render: (s) => (s.totalCost ? formatCurrency(s.totalCost) : "—"),
    sortValue: (s) => s.totalCost ?? -1,
  },
  {
    key: "messages",
    label: "Messages",
    align: "right",
    render: (s) => s.messageCount,
    sortValue: (s) => s.messageCount,
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

interface SessionTableProps {
  sessions: UsageData["recentSessions"];
}

export function SessionTable({ sessions }: SessionTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(DEFAULT_SORT);

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  };

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key)!;
    const multiplier = sort.dir === "asc" ? 1 : -1;
    return [...sessions].sort((a, b) => {
      const va = col.sortValue(a);
      const vb = col.sortValue(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * multiplier;
      }
      return String(va).localeCompare(String(vb)) * multiplier;
    });
  }, [sessions, sort]);

  if (sessions.length === 0) return null;

  return (
    <Card>
      <div className="px-6 py-4 border-b">
        <h3 className="font-semibold">Recent Sessions</h3>
      </div>
      <CardContent className="pt-0 px-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={`py-2.5 px-3 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors ${
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
              {sorted.map((session) => (
                <tr
                  key={session.id}
                  className="border-b last:border-0 hover:bg-muted/50 transition-colors"
                >
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className={`py-2 px-3 ${
                        col.align === "right" ? "text-right tabular-nums" : "truncate max-w-[200px]"
                      }`}
                      title={
                        col.key === "name"
                          ? (session.sessionName || `Session ${session.id.slice(0, 8)}`)
                          : col.key === "project"
                            ? session.project
                            : col.key === "model"
                              ? session.primaryModel
                              : undefined
                      }
                    >
                      {col.render(session)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
