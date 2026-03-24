import React, { useState, useCallback } from "react";
import {
  AreaChart,
  Area,
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
  formatTokens,
  formatDate,
  chartCursorStyle,
} from "./chart-theme";
import type { UsageData } from "./types";

interface TokenChartProps {
  daily: UsageData["daily"];
}

const SERIES = [
  { key: "inputTokens", name: "Input", color: COST_COLORS.input },
  { key: "outputTokens", name: "Output", color: COST_COLORS.output },
  { key: "cacheReadTokens", name: "Cache Read", color: COST_COLORS.cacheRead },
  { key: "cacheWriteTokens", name: "Cache Write", color: COST_COLORS.cacheWrite },
] as const;

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
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatTokens(p.value)}</span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid hsl(var(--border))", marginTop: "4px", paddingTop: "4px", display: "flex", justifyContent: "space-between", fontWeight: 600, ...tooltipItemStyle }}>
        <span>Total</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatTokens(total)}</span>
      </div>
    </div>
  );
}

export function TokenChart({ daily }: TokenChartProps) {
  // Interactive legend: track which series are hidden
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const handleLegendClick = useCallback((e: any) => {
    const key = e.dataKey;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (daily.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Token Usage Over Time</CardTitle>
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
        <CardTitle>Token Usage Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart
            data={daily}
            margin={{ top: 20, right: 30, left: 0, bottom: 5 }}
          >
            <defs>
              {SERIES.map((s) => (
                <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={s.color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
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
              tickFormatter={formatTokens}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={chartCursorStyle}
            />
            <Legend
              onClick={handleLegendClick}
              wrapperStyle={{ cursor: "pointer" }}
              formatter={(value: string, entry: any) => (
                <span style={{
                  color: hidden.has(entry.dataKey)
                    ? "hsl(var(--muted-foreground))"
                    : "hsl(var(--foreground))",
                  textDecoration: hidden.has(entry.dataKey) ? "line-through" : "none",
                  opacity: hidden.has(entry.dataKey) ? 0.5 : 1,
                }}>
                  {value}
                </span>
              )}
            />
            {/* Unstacked: each series independent so cache reads don't crush others */}
            {SERIES.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                fillOpacity={1}
                fill={`url(#grad-${s.key})`}
                name={s.name}
                hide={hidden.has(s.key)}
                activeDot={{
                  r: 5,
                  strokeWidth: 2,
                  stroke: s.color,
                  fill: "hsl(var(--background))",
                }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
