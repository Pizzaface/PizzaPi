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
  // Calculate average daily cost from daily data
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
          <CardTitle className="text-sm font-medium text-muted-foreground">Avg Daily Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{summary.sessionsWithCost === 0 ? "—" : formatCurrency(avgDailyCost)}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {daily.length} days of data
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
