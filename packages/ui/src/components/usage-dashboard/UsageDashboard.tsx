import React, { useState, useEffect } from "react";
import { PeriodSelector } from "./PeriodSelector";
import { SummaryCards } from "./SummaryCards";
import { SessionStats } from "./SessionStats";
import { CostChart } from "./CostChart";
import { TokenChart } from "./TokenChart";
import { ModelBreakdown } from "./ModelBreakdown";
import { ProjectBreakdown } from "./ProjectBreakdown";
import { SessionTable } from "./SessionTable";
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
      <SessionTable sessions={data.recentSessions} />
    </div>
  );
}
