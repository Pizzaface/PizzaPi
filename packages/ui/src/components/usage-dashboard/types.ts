/** API response shape */
export interface UsageData {
  generatedAt: string;
  dateRange: { from: string; to: string };
  totalDateRange: { from: string; to: string };

  summary: {
    totalSessions: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    avgSessionCost: number;
    avgSessionTokens: number;
    avgSessionDurationMs: number | null;
    sessionsWithCost: number;
  };

  daily: Array<{
    date: string;
    sessions: number;
    cost: number;
    costInput: number;
    costOutput: number;
    costCacheRead: number;
    costCacheWrite: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;

  byModel: Array<{
    provider: string;
    model: string;
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }>;

  byProject: Array<{
    project: string;
    projectShort: string;
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }>;

  recentSessions: Array<{
    id: string;
    project: string;
    projectShort: string;
    sessionName: string | null;
    startedAt: string;
    endedAt: string | null;
    messageCount: number;
    totalCost: number | null;
    primaryModel: string;
  }>;
}

export type UsageRange = "7d" | "30d" | "90d" | "all";
