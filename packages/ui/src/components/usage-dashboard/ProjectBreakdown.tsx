import React, { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipItemStyle,
  formatCurrency,
} from "./chart-theme";
import type { UsageData } from "./types";

interface ProjectBreakdownProps {
  byProject: UsageData["byProject"];
}

// ── Separate charts for sessions and cost to avoid the dual-axis visual lie ─

const SESSION_COLOR = "#3b82f6"; // blue-500
const COST_COLOR = "#f97316";    // orange-500
const TOP_N = 8; // Show top N projects by default

function SessionTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={tooltipContentStyle}>
      <p style={tooltipLabelStyle}>{d.projectShort}</p>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", ...tooltipItemStyle }}>
        <span>Sessions</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{d.sessions}</span>
      </div>
    </div>
  );
}

function CostTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={tooltipContentStyle}>
      <p style={tooltipLabelStyle}>{d.projectShort}</p>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", ...tooltipItemStyle }}>
        <span>Cost</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCurrency(d.cost)}</span>
      </div>
    </div>
  );
}

/** Compute a reasonable chart height based on the number of projects. */
function chartHeight(itemCount: number): number {
  return Math.max(180, itemCount * 32 + 40);
}

export function ProjectBreakdown({ byProject }: ProjectBreakdownProps) {
  const [showAll, setShowAll] = useState(false);

  if (byProject.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
        </CardHeader>
        <CardContent className="h-48 flex items-center justify-center text-muted-foreground">
          No data available
        </CardContent>
      </Card>
    );
  }

  // Sort by sessions descending, take top N unless expanded
  const sorted = [...byProject].sort((a, b) => b.sessions - a.sessions);
  const visible = showAll ? sorted : sorted.slice(0, TOP_N);
  const hiddenCount = sorted.length - TOP_N;

  const data = visible.map((p) => ({
    ...p,
    name: p.projectShort.length > 24 ? p.projectShort.slice(0, 22) + "…" : p.projectShort,
  }));

  const h = chartHeight(data.length);
  // Adaptive left margin: measure longest label (rough heuristic: 6.5px per char, capped)
  const maxLabelLen = Math.max(...data.map((d) => d.name.length));
  const leftMargin = Math.min(180, Math.max(60, maxLabelLen * 6.5 + 12));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Sessions by Project */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle>Sessions by Project</CardTitle>
          {hiddenCount > 0 && (
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show top" : `+${hiddenCount} more`}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 24, left: leftMargin, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                allowDecimals={false}
              />
              <YAxis
                dataKey="name"
                type="category"
                width={leftMargin - 8}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <Tooltip content={<SessionTooltip />} cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }} />
              <Bar
                dataKey="sessions"
                fill={SESSION_COLOR}
                name="Sessions"
                radius={[0, 4, 4, 0]}
                activeBar={{ fillOpacity: 0.8, stroke: SESSION_COLOR, strokeWidth: 1 }}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Cost by Project */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle>Cost by Project</CardTitle>
          {hiddenCount > 0 && (
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show top" : `+${hiddenCount} more`}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 24, left: leftMargin, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickFormatter={formatCurrency}
              />
              <YAxis
                dataKey="name"
                type="category"
                width={leftMargin - 8}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <Tooltip content={<CostTooltip />} cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }} />
              <Bar
                dataKey="cost"
                fill={COST_COLOR}
                name="Cost"
                radius={[0, 4, 4, 0]}
                activeBar={{ fillOpacity: 0.8, stroke: COST_COLOR, strokeWidth: 1 }}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
