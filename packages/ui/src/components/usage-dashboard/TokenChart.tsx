import React from "react";
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
import type { UsageData } from "./types";

interface TokenChartProps {
  daily: UsageData["daily"];
}

const colors = {
  input: "#3b82f6",
  output: "#ef4444",
  cacheRead: "#8b5cf6",
  cacheWrite: "#f59e0b",
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toString();
}

export function TokenChart({ daily }: TokenChartProps) {
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
              <linearGradient id="colorInput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.input} stopOpacity={0.8} />
                <stop offset="95%" stopColor={colors.input} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorOutput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.output} stopOpacity={0.8} />
                <stop offset="95%" stopColor={colors.output} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorCacheRead" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.cacheRead} stopOpacity={0.8} />
                <stop offset="95%" stopColor={colors.cacheRead} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorCacheWrite" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.cacheWrite} stopOpacity={0.8} />
                <stop offset="95%" stopColor={colors.cacheWrite} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="date"
              className="text-xs text-muted-foreground"
              tick={{ fontSize: 12 }}
            />
            <YAxis
              className="text-xs text-muted-foreground"
              tick={{ fontSize: 12 }}
              tickFormatter={formatTokens}
            />
            <Tooltip
              formatter={(value) => formatTokens(value as number)}
              contentStyle={{
                backgroundColor: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
              }}
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="inputTokens"
              stackId="1"
              stroke={colors.input}
              fillOpacity={1}
              fill="url(#colorInput)"
              name="Input Tokens"
            />
            <Area
              type="monotone"
              dataKey="outputTokens"
              stackId="1"
              stroke={colors.output}
              fillOpacity={1}
              fill="url(#colorOutput)"
              name="Output Tokens"
            />
            <Area
              type="monotone"
              dataKey="cacheReadTokens"
              stackId="1"
              stroke={colors.cacheRead}
              fillOpacity={1}
              fill="url(#colorCacheRead)"
              name="Cache Read Tokens"
            />
            <Area
              type="monotone"
              dataKey="cacheWriteTokens"
              stackId="1"
              stroke={colors.cacheWrite}
              fillOpacity={1}
              fill="url(#colorCacheWrite)"
              name="Cache Write Tokens"
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
