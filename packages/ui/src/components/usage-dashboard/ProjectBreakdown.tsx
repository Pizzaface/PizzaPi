import React from "react";
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
  return Math.max(200, itemCount * 40 + 40);
}

export function ProjectBreakdown({ byProject }: ProjectBreakdownProps) {
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

  const data = byProject.map((p) => ({
    ...p,
    name: p.projectShort,
  }));

  const h = chartHeight(data.length);
  // Adaptive left margin: measure longest label (rough heuristic: 7px per char)
  const maxLabelLen = Math.max(...data.map((d) => d.name.length));
  const leftMargin = Math.min(200, Math.max(80, maxLabelLen * 7 + 16));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Sessions by Project */}
      <Card>
        <CardHeader>
          <CardTitle>Sessions by Project</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 30, left: leftMargin, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                allowDecimals={false}
              />
              <YAxis
                dataKey="name"
                type="category"
                width={leftMargin - 8}
                tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip content={<SessionTooltip />} cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.4 }} />
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
        <CardHeader>
          <CardTitle>Cost by Project</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 30, left: leftMargin, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={formatCurrency}
              />
              <YAxis
                dataKey="name"
                type="category"
                width={leftMargin - 8}
                tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip content={<CostTooltip />} cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.4 }} />
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
