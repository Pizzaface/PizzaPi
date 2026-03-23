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

interface ProjectBreakdownProps {
  byProject: UsageData["byProject"];
}

const colors = {
  sessions: "#3b82f6",
  cost: "#ef4444",
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function ProjectBreakdown({ byProject }: ProjectBreakdownProps) {
  if (byProject.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sessions by Project</CardTitle>
        </CardHeader>
        <CardContent className="h-96 flex items-center justify-center text-muted-foreground">
          No data available
        </CardContent>
      </Card>
    );
  }

  const data = byProject.map((p) => ({
    ...p,
    name: p.projectShort,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions by Project</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 200, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis type="number" className="text-xs text-muted-foreground" />
            <YAxis
              dataKey="name"
              type="category"
              className="text-xs text-muted-foreground"
              width={190}
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              formatter={(value, name) => {
                if (name === "cost") {
                  return formatCurrency(value as number);
                }
                return value;
              }}
              contentStyle={{
                backgroundColor: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
              }}
            />
            <Legend />
            <Bar
              dataKey="sessions"
              fill={colors.sessions}
              name="Sessions"
              radius={[0, 4, 4, 0]}
            />
            <Bar
              dataKey="cost"
              fill={colors.cost}
              name="Cost"
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
