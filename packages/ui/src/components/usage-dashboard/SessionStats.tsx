import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatTokens } from "./chart-theme";
import type { UsageData } from "./types";

interface SessionStatsProps {
  summary: UsageData["summary"];
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatCurrencyNullable(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return formatCurrency(value);
}

function StatCard({ title, value, subtitle }: { title: string; value: string; subtitle: string }) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

export function SessionStats({ summary }: SessionStatsProps) {
  const avgCostPerSession = summary.sessionsWithCost > 0 ? summary.avgSessionCost : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title="Avg Duration"
        value={formatDuration(summary.avgSessionDurationMs)}
        subtitle="per session"
      />
      <StatCard
        title="Avg Tokens"
        value={formatTokens(summary.avgSessionTokens)}
        subtitle="per session"
      />
      <StatCard
        title="Avg Cost"
        value={formatCurrencyNullable(avgCostPerSession)}
        subtitle={summary.sessionsWithCost > 0 ? "per session" : "no cost data"}
      />
      <StatCard
        title="Avg Input Tokens"
        value={summary.totalSessions > 0
          ? formatTokens(Math.round(summary.totalInputTokens / summary.totalSessions))
          : "—"}
        subtitle="input tokens per session"
      />
    </div>
  );
}
