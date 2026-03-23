import React from "react";
import {
  PieChart,
  Pie,
  Cell,
  Legend,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UsageData } from "./types";

interface ModelBreakdownProps {
  byModel: UsageData["byModel"];
}

const colors = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#14b8a6",
  "#f97316",
  "#6366f1",
];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function ModelBreakdown({ byModel }: ModelBreakdownProps) {
  if (byModel.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage by Model</CardTitle>
        </CardHeader>
        <CardContent className="h-96 flex items-center justify-center text-muted-foreground">
          No data available
        </CardContent>
      </Card>
    );
  }

  const totalCost = byModel.reduce((sum, m) => sum + m.cost, 0);
  const data = byModel.map((m) => ({
    ...m,
    label: m.model,
    value: m.cost,
  }));

  const renderLabel = (entry: any) => {
    const percentage = totalCost > 0 ? ((entry.value / totalCost) * 100).toFixed(1) : "0";
    return `${percentage}%`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by Model</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={renderLabel}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {data.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={colors[index % colors.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => formatCurrency(value as number)}
                  contentStyle={{
                    backgroundColor: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            {data.map((m, idx) => (
              <div key={m.model} className="text-sm flex items-center gap-3">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: colors[idx % colors.length],
                  }}
                />
                <div className="flex-1">
                  <div className="font-medium">{m.model}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.provider}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium">{formatCurrency(m.cost)}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.sessions} sessions
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
