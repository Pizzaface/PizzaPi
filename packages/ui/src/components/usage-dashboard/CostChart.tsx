import React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  COST_COLORS,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipItemStyle,
  formatCurrency,
  formatDate,
  chartCursorStyle,
} from "./chart-theme";
import type { UsageData } from "./types";

interface CostChartProps {
  daily: UsageData["daily"];
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum: number, p: any) => sum + (p.value ?? 0), 0);
  return (
    <div style={tooltipContentStyle}>
      <p style={tooltipLabelStyle}>{formatDate(label)}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: "16px", ...tooltipItemStyle }}>
          <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: p.color, display: "inline-block" }} />
            {p.name}
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCurrency(p.value)}</span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid hsl(var(--border))", marginTop: "4px", paddingTop: "4px", display: "flex", justifyContent: "space-between", fontWeight: 600, ...tooltipItemStyle }}>
        <span>Total</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

export function CostChart({ daily }: CostChartProps) {
  if (daily.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost Over Time</CardTitle>
        </CardHeader>
        <CardContent className="h-96 flex items-center justify-center text-muted-foreground">
          No data available
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart
            data={daily}
            margin={{ top: 20, right: 30, left: 0, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="date"
              className="text-xs"
              tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={formatDate}
            />
            <YAxis
              className="text-xs"
              tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={formatCurrency}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={chartCursorStyle}
            />
            <Legend />
            <Bar
              dataKey="costInput"
              stackId="cost"
              fill={COST_COLORS.input}
              name="Input Cost"
              radius={[0, 0, 0, 0]}
              activeBar={{ fillOpacity: 0.8, stroke: COST_COLORS.input, strokeWidth: 1 }}
            />
            <Bar
              dataKey="costOutput"
              stackId="cost"
              fill={COST_COLORS.output}
              name="Output Cost"
              radius={[0, 0, 0, 0]}
              activeBar={{ fillOpacity: 0.8, stroke: COST_COLORS.output, strokeWidth: 1 }}
            />
            <Bar
              dataKey="costCacheRead"
              stackId="cost"
              fill={COST_COLORS.cacheRead}
              name="Cache Read Cost"
              radius={[0, 0, 0, 0]}
              activeBar={{ fillOpacity: 0.8, stroke: COST_COLORS.cacheRead, strokeWidth: 1 }}
            />
            <Bar
              dataKey="costCacheWrite"
              stackId="cost"
              fill={COST_COLORS.cacheWrite}
              name="Cache Write Cost"
              radius={[4, 4, 0, 0]}
              activeBar={{ fillOpacity: 0.8, stroke: COST_COLORS.cacheWrite, strokeWidth: 1 }}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
