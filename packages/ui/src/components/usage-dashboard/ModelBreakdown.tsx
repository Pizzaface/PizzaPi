import React from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Sector,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PIE_COLORS,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipItemStyle,
  formatCurrency,
} from "./chart-theme";
import type { UsageData } from "./types";

interface ModelBreakdownProps {
  byModel: UsageData["byModel"];
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

  function CustomTooltip({ active, payload }: any) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const pct = totalCost > 0 ? ((d.value / totalCost) * 100).toFixed(1) : "0";
    return (
      <div style={tooltipContentStyle}>
        <p style={tooltipLabelStyle}>{d.label}</p>
        <div style={tooltipItemStyle}>
          <span style={{ color: "var(--muted-foreground)" }}>{d.provider}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", ...tooltipItemStyle }}>
          <span>Cost</span>
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCurrency(d.value)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", ...tooltipItemStyle }}>
          <span>Share</span>
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", ...tooltipItemStyle }}>
          <span>Sessions</span>
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{d.sessions}</span>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by Model</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1 min-w-0">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={renderLabel}
                  outerRadius="80%"
                  innerRadius="40%"
                  fill="#8884d8"
                  dataKey="value"
                  activeShape={(props: any) => (
                    <Sector
                      {...props}
                      outerRadius={props.outerRadius + 6}
                      stroke={props.fill}
                      strokeWidth={2}
                    />
                  )}
                >
                  {data.map((_entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={PIE_COLORS[index % PIE_COLORS.length]}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            {data.map((m, idx) => (
              <div
                key={m.model}
                className="text-sm flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
              >
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{m.model}</div>
                  <div className="text-xs text-muted-foreground">{m.provider}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="font-medium">{formatCurrency(m.cost)}</div>
                  <div className="text-xs text-muted-foreground">{m.sessions} sessions</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
