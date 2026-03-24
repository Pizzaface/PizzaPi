import React, { useState, useEffect } from "react";
import { PeriodSelector } from "./PeriodSelector";
import { SummaryCards } from "./SummaryCards";
import { SessionStats } from "./SessionStats";
import { CostChart } from "./CostChart";
import { TokenChart } from "./TokenChart";
import { ModelBreakdown } from "./ModelBreakdown";
import { ProjectBreakdown } from "./ProjectBreakdown";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Loader2 } from "lucide-react";
import type { UsageData, UsageRange } from "./types";

interface UsageDashboardProps {
  runnerId: string;
}

export function UsageDashboard({ runnerId }: UsageDashboardProps) {
  const [range, setRange] = useState<UsageRange>("90d");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchUsageData = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/runners/${encodeURIComponent(runnerId)}/usage?range=${range}`,
          {
            headers: {
              Accept: "application/json",
            },
            credentials: "include",
          },
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch usage data");
        }

        const usageData = await response.json();
        setData(usageData);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred",
        );
      } finally {
        setLoading(false);
      }
    };

    fetchUsageData();
  }, [runnerId, range]);

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-4 border border-red-500/30 bg-red-500/5 rounded-lg">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <div>
            <h3 className="font-medium text-red-900 dark:text-red-200">
              Error loading usage data
            </h3>
            <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        </div>
        <PeriodSelector value={range} onChange={setRange} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading usage data...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">No usage data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Period Selector */}
      <PeriodSelector value={range} onChange={setRange} />

      {/* Summary Cards */}
      <SummaryCards summary={data.summary} daily={data.daily} />

      {/* Session Stats */}
      <SessionStats summary={data.summary} />

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CostChart daily={data.daily} />
        <TokenChart daily={data.daily} />
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4">
        <ModelBreakdown byModel={data.byModel} />
        <ProjectBreakdown byProject={data.byProject} />
      </div>

      {/* Recent Sessions */}
      {data.recentSessions.length > 0 && (
        <Card>
          <div className="px-6 py-4 border-b">
            <h3 className="font-semibold">Recent Sessions</h3>
          </div>
          <CardContent className="pt-4">
            <div className="space-y-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr className="text-muted-foreground">
                    <th className="text-left py-2 px-2 font-medium">
                      Session
                    </th>
                    <th className="text-left py-2 px-2 font-medium">
                      Project
                    </th>
                    <th className="text-left py-2 px-2 font-medium">Model</th>
                    <th className="text-right py-2 px-2 font-medium">Cost</th>
                    <th className="text-right py-2 px-2 font-medium">
                      Messages
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentSessions.map((session) => (
                    <tr
                      key={session.id}
                      className="border-b last:border-0 hover:bg-muted/50 transition-colors"
                    >
                      <td
                        className="py-2 px-2 truncate max-w-xs"
                        title={session.sessionName || `Session ${session.id.slice(0, 8)}`}
                      >
                        {session.sessionName || `Session ${session.id.slice(0, 8)}`}
                      </td>
                      <td
                        className="py-2 px-2 truncate max-w-xs"
                        title={session.project}
                      >
                        {session.projectShort}
                      </td>
                      <td
                        className="py-2 px-2 truncate"
                        title={session.primaryModel}
                      >
                        {session.primaryModel}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {session.totalCost
                          ? `$${session.totalCost.toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {session.messageCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
