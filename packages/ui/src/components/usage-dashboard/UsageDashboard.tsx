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
import { Skeleton } from "../ui/skeleton";
import type { UsageData, UsageRange } from "./types";

interface UsageDashboardProps {
  runnerId: string;
  onInspectSession?: (sessionId: string) => void;
}

export function UsageDashboard({ runnerId, onInspectSession }: UsageDashboardProps) {
  const [range, setRange] = useState<UsageRange>("90d");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

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
            signal: controller.signal,
          },
        );

        if (!active) return;

        if (!response.ok) {
          // Proxy errors (e.g. 502) may return non-JSON bodies.
          const errorData = await response.json().catch(() => null);
          throw new Error(errorData?.error || `Failed to fetch usage data (HTTP ${response.status})`);
        }

        const usageData = await response.json();
        // Guard against unexpected payload shapes so we render the
        // "No usage data" zero-state instead of crashing downstream.
        const valid = usageData && typeof usageData === "object" &&
          usageData.summary && Array.isArray(usageData.daily);
        if (active) setData(valid ? usageData : null);
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred",
        );
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchUsageData();

    return () => {
      active = false;
      controller.abort();
    };
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

  // Keep the period selector visible while (re)loading so changing the range
  // doesn't blank the whole view and lose context; show skeletons in place of
  // the cards/charts instead of a centered full-view spinner.
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <PeriodSelector value={range} onChange={setRange} />
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading usage data" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="font-medium text-sm">No usage data yet</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Cost and token usage are recorded as sessions run on this runner.
          Start a session and send a few messages, then check back here.
        </p>
        <div className="pt-1"><PeriodSelector value={range} onChange={setRange} /></div>
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
      <SessionTable sessions={data.recentSessions} onInspectSession={onInspectSession} />
    </div>
  );
}
