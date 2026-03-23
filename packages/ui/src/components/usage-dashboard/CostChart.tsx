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
import type { UsageData } from "./types";

interface CostChartProps {
  daily: UsageData["daily"];
}

const colors = {
  input: "#3b82f6",
  output: "#ef4444",
  cacheRead: "#8b5cf6",
  cacheWrite: "#f59e0b",
};

function formatCurrency(value: number): string {
  if (value === 0) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
              className="text-xs text-muted-foreground"
              tick={{ fontSize: 12 }}
            />
            <YAxis
              className="text-xs text-muted-foreground"
              tick={{ fontSize: 12 }}
              tickFormatter={formatCurrency}
            />
            <Tooltip
              formatter={(value) => formatCurrency(value as number)}
              contentStyle={{
                backgroundColor: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
              }}
            />
            <Legend />
            <Bar
              dataKey="costInput"
              stackId="cost"
              fill={colors.input}
              name="Input Cost"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="costOutput"
              stackId="cost"
              fill={colors.output}
              name="Output Cost"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="costCacheRead"
              stackId="cost"
              fill={colors.cacheRead}
              name="Cache Read Cost"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="costCacheWrite"
              stackId="cost"
              fill={colors.cacheWrite}
              name="Cache Write Cost"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
