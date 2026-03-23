import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UsageData } from "./types";

interface SummaryCardsProps {
  summary: UsageData["summary"];
  daily: UsageData["daily"];
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toString();
}

export function SummaryCards({ summary, daily }: SummaryCardsProps) {
  // Calculate average daily cost from daily data.
  // TODO: This divides by the number of *active* days (days with at least one
  // usage event), not the total calendar days in the selected range.
  // "Avg Daily Cost" over a 30-day range with only 10 active days will be 3×
  // higher than a pure calendar average.  Consider whether to display both, or
  // rename the label to "Avg Cost (active days)" to avoid confusion.
  const avgDailyCost = daily.length > 0 ? daily.reduce((sum, d) => sum + d.cost, 0) / daily.length : 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{summary.sessionsWithCost === 0 ? "—" : formatCurrency(summary.totalCost)}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {summary.sessionsWithCost} of {summary.totalSessions} sessions with cost data
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{summary.totalSessions}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {summary.avgSessionCost > 0 ? `Avg ${formatCurrency(summary.avgSessionCost)}/session` : "No cost data"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}</div>
          <p className="text-xs text-muted-foreground mt-1">
            Input + Output
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Avg Cost / Active Day</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{summary.sessionsWithCost === 0 ? "—" : formatCurrency(avgDailyCost)}</div>
          <p className="text-xs text-muted-foreground mt-1">
            across {daily.length} active day{daily.length === 1 ? "" : "s"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
