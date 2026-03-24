import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { formatCurrency, formatTokens } from "./chart-theme";
import type { UsageData } from "./types";

interface SummaryCardsProps {
  summary: UsageData["summary"];
  daily: UsageData["daily"];
}

function StatCard({ title, value, subtitle, tooltip }: {
  title: string;
  value: string;
  subtitle: string;
  tooltip?: string;
}) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {title}
          {tooltip && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  {tooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

export function SummaryCards({ summary, daily }: SummaryCardsProps) {
  const avgDailyCost = daily.length > 0 ? daily.reduce((sum, d) => sum + d.cost, 0) / daily.length : 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title="Total Cost"
        value={summary.sessionsWithCost === 0 ? "—" : formatCurrency(summary.totalCost)}
        subtitle={`${summary.sessionsWithCost} of ${summary.totalSessions} sessions with cost data`}
        tooltip="Sum of all token costs (input, output, cache read, cache write) across sessions with cost data."
      />
      <StatCard
        title="Sessions"
        value={String(summary.totalSessions)}
        subtitle={summary.avgSessionCost > 0 ? `Avg ${formatCurrency(summary.avgSessionCost)}/session` : "No cost data"}
      />
      <StatCard
        title="Total Tokens"
        value={formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}
        subtitle="Input + Output"
        tooltip="Total input and output tokens. Does not include cache read/write tokens."
      />
      <StatCard
        title="Avg Cost / Active Day"
        value={summary.sessionsWithCost === 0 ? "—" : formatCurrency(avgDailyCost)}
        subtitle={`across ${daily.length} active day${daily.length === 1 ? "" : "s"}`}
        tooltip="Average cost per day that had at least one session. Days with no activity are excluded, so this will be higher than a calendar-day average."
      />
    </div>
  );
}
