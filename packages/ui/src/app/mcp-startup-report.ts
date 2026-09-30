/** MCP startup report as emitted by the runner (heartbeat, meta, or event). */
export interface McpStartupReport {
  slow?: boolean;
  showSlowWarning?: boolean;
  errors?: Array<{ server: string; error: string }>;
  serverTimings?: Array<{ name: string; durationMs: number; toolCount: number; timedOut: boolean; error?: string }>;
  totalDurationMs?: number;
  ts?: number;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Build the system-message text for an MCP startup report, or null when the
 * report is neither slow (with the warning enabled) nor carries errors.
 *
 * Only servers that errored, timed out, or took ≥3s are listed individually.
 */
export function formatMcpStartupReport(
  mcpReport: McpStartupReport,
): { content: string; isError: boolean } | null {
  const hasErrors = Array.isArray(mcpReport.errors) && mcpReport.errors.length > 0;
  const showSlow = mcpReport.showSlowWarning !== false;
  const isSlow = mcpReport.slow === true && showSlow;
  if (!hasErrors && !isSlow) return null;
  const totalMs = typeof mcpReport.totalDurationMs === "number" ? mcpReport.totalDurationMs : 0;
  const totalDur = formatDuration(totalMs);
  const parts: string[] = [];
  if (isSlow) parts.push(`⏱ MCP startup took ${totalDur}`);
  const timings = Array.isArray(mcpReport.serverTimings) ? mcpReport.serverTimings : [];
  const noteworthy = timings.filter((t) => t.error || t.timedOut || t.durationMs >= 3000);
  for (const t of noteworthy) {
    const dur = formatDuration(t.durationMs);
    if (t.timedOut) parts.push(`  ⏱ ${t.name}: timed out (${dur})`);
    else if (t.error) parts.push(`  ✗ ${t.name}: ${t.error} (${dur})`);
    else parts.push(`  ● ${t.name}: ${dur}`);
  }
  if (hasErrors && !isSlow) {
    const errLines = mcpReport.errors!.map((e) => `  ✗ ${e.server}: ${e.error}`);
    parts.push(`⚠ MCP server errors:\n${errLines.join("\n")}`);
  }
  if (isSlow) parts.push("Tip: Use --safe-mode or --no-mcp for instant startup.");
  if (parts.length === 0) return null;
  return { content: parts.join("\n"), isError: hasErrors };
}
