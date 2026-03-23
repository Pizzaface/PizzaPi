import { Database } from "bun:sqlite";
import type { UsageData, UsageRange } from "./types.js";

export function getUsageData(db: Database, range: UsageRange = "90d"): UsageData {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  // Calculate date range
  let fromTimestamp = now;
  switch (range) {
    case "7d":
      fromTimestamp = now - 7 * oneDay;
      break;
    case "30d":
      fromTimestamp = now - 30 * oneDay;
      break;
    case "90d":
      fromTimestamp = now - 90 * oneDay;
      break;
    case "all":
      fromTimestamp = 0;
      break;
  }

  // Get total date range in DB (min and max session starts)
  const totalRange = db.query<
    { minStart: number | null; maxStart: number | null },
    []
  >(
    `SELECT MIN(started_at) as minStart, MAX(started_at) as maxStart FROM sessions`
  ).get() || { minStart: null, maxStart: null };

  const totalDateRangeStart = totalRange.minStart || now;
  const totalDateRangeEnd = totalRange.maxStart || now;

  // Summary statistics
  const summary = db.query<
    {
      totalSessions: number;
      totalCost: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheWriteTokens: number;
      sessionsWithCost: number;
      avgCost: number;
      avgTokens: number;
      sessionsWithDuration: number;
      totalDurationMs: number;
    },
    [number]
  >(
    `
    SELECT
      COUNT(DISTINCT s.id) as totalSessions,
      COALESCE(SUM(s.total_cost), 0) as totalCost,
      COALESCE(SUM(s.total_input), 0) as totalInputTokens,
      COALESCE(SUM(s.total_output), 0) as totalOutputTokens,
      COALESCE(SUM(s.total_cache_read), 0) as totalCacheReadTokens,
      COALESCE(SUM(s.total_cache_write), 0) as totalCacheWriteTokens,
      COUNT(CASE WHEN s.total_cost IS NOT NULL THEN 1 END) as sessionsWithCost,
      COALESCE(AVG(CASE WHEN s.total_cost IS NOT NULL THEN s.total_cost END), 0) as avgCost,
      CASE WHEN COUNT(DISTINCT s.id) > 0 
        THEN COALESCE(SUM(s.total_input + s.total_output + s.total_cache_read + s.total_cache_write), 0) / COUNT(DISTINCT s.id)
        ELSE 0
      END as avgTokens,
      COUNT(CASE WHEN s.ended_at IS NOT NULL THEN 1 END) as sessionsWithDuration,
      COALESCE(SUM(CASE WHEN s.ended_at IS NOT NULL THEN s.ended_at - s.started_at ELSE 0 END), 0) as totalDurationMs
    FROM sessions s
    WHERE s.started_at >= ?
  `,
  ).get(fromTimestamp) || {
    totalSessions: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    sessionsWithCost: 0,
    avgCost: 0,
    avgTokens: 0,
    sessionsWithDuration: 0,
    totalDurationMs: 0,
  };

  const avgSessionDurationMs =
    summary.sessionsWithDuration > 0
      ? summary.totalDurationMs / summary.sessionsWithDuration
      : null;

  // Daily rollups
  const daily = db.query<
    {
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
    },
    [number]
  >(
    `
    SELECT
      DATE(u.timestamp / 1000, 'unixepoch') as date,
      COUNT(DISTINCT u.session_id) as sessions,
      COALESCE(SUM(u.cost_usd), 0) as cost,
      COALESCE(SUM(u.cost_input), 0) as costInput,
      COALESCE(SUM(u.cost_output), 0) as costOutput,
      COALESCE(SUM(u.cost_cache_read), 0) as costCacheRead,
      COALESCE(SUM(u.cost_cache_write), 0) as costCacheWrite,
      COALESCE(SUM(u.input_tokens), 0) as inputTokens,
      COALESCE(SUM(u.output_tokens), 0) as outputTokens,
      COALESCE(SUM(u.cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(u.cache_write_tokens), 0) as cacheWriteTokens
    FROM usage_events u
    WHERE u.timestamp >= ?
    GROUP BY DATE(u.timestamp / 1000, 'unixepoch')
    ORDER BY date ASC
  `,
  ).all(fromTimestamp);

  // By model breakdown (top 20 by cost)
  const byModel = db.query<
    {
      provider: string;
      model: string;
      sessions: number;
      cost: number;
      inputTokens: number;
      outputTokens: number;
    },
    [number]
  >(
    `
    SELECT
      u.provider,
      u.model,
      COUNT(DISTINCT u.session_id) as sessions,
      COALESCE(SUM(u.cost_usd), 0) as cost,
      COALESCE(SUM(u.input_tokens), 0) as inputTokens,
      COALESCE(SUM(u.output_tokens), 0) as outputTokens
    FROM usage_events u
    WHERE u.timestamp >= ?
    GROUP BY u.provider, u.model
    ORDER BY cost DESC
    LIMIT 20
  `,
  ).all(fromTimestamp);

  // By project breakdown (top 20 by cost)
  const byProjectRaw = db.query<
    {
      project: string;
      sessions: number;
      cost: number;
      inputTokens: number;
      outputTokens: number;
    },
    [number]
  >(
    `
    SELECT
      u.project,
      COUNT(DISTINCT u.session_id) as sessions,
      COALESCE(SUM(u.cost_usd), 0) as cost,
      COALESCE(SUM(u.input_tokens), 0) as inputTokens,
      COALESCE(SUM(u.output_tokens), 0) as outputTokens
    FROM usage_events u
    WHERE u.timestamp >= ?
    GROUP BY u.project
    ORDER BY cost DESC
    LIMIT 20
  `,
  ).all(fromTimestamp);

  const byProject = byProjectRaw.map((p) => ({
    project: p.project,
    projectShort: p.project.split("/").pop() || p.project,
    sessions: p.sessions,
    cost: p.cost,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
  }));

  // Recent sessions (last 50 in date range)
  const recentSessionsRaw = db.query<
    {
      id: string;
      project: string;
      sessionName: string | null;
      startedAt: number;
      endedAt: number | null;
      messageCount: number;
      totalCost: number | null;
      primaryModel: string;
    },
    [number]
  >(
    `
    SELECT
      id,
      project,
      session_name as sessionName,
      started_at as startedAt,
      ended_at as endedAt,
      message_count as messageCount,
      total_cost as totalCost,
      primary_model as primaryModel
    FROM sessions
    WHERE started_at >= ?
    ORDER BY started_at DESC
    LIMIT 50
  `,
  ).all(fromTimestamp);

  const recentSessions = recentSessionsRaw.map((s) => ({
    id: s.id,
    project: s.project,
    projectShort: s.project.split("/").pop() || s.project,
    sessionName: s.sessionName,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    messageCount: s.messageCount,
    totalCost: s.totalCost,
    primaryModel: s.primaryModel,
  }));

  return {
    generatedAt: new Date().toISOString(),
    dateRange: {
      from: new Date(fromTimestamp).toISOString(),
      to: new Date(now).toISOString(),
    },
    totalDateRange: {
      from: new Date(totalDateRangeStart).toISOString(),
      to: new Date(totalDateRangeEnd).toISOString(),
    },
    summary: {
      totalSessions: summary.totalSessions,
      totalCost: summary.totalCost,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCacheReadTokens: summary.totalCacheReadTokens,
      totalCacheWriteTokens: summary.totalCacheWriteTokens,
      avgSessionCost: summary.avgCost,
      avgSessionTokens: summary.avgTokens,
      avgSessionDurationMs,
      sessionsWithCost: summary.sessionsWithCost,
    },
    daily,
    byModel,
    byProject,
    recentSessions,
  };
}
