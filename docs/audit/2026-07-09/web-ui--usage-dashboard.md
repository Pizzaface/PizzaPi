# Audit: web-ui/usage-dashboard.mdx

Verdict: MINOR ISSUES

Claims checked: 49 | Failed: 4

## Findings

### [P2] "Cost by Project" is sorted by session count, not by cost
- Claim (line ~62): "Cost by Project — which projects cost the most"
- Reality: `ProjectBreakdown.tsx` sorts BOTH charts by the same array `sorted = [...byProject].sort((a, b) => b.sessions - a.sessions)` (packages/ui/src/components/usage-dashboard/ProjectBreakdown.tsx:60). The "Cost by Project" chart therefore renders projects ordered by session count, not by cost. The server does return the top 20 by cost (`ORDER BY cost DESC LIMIT 20`, packages/cli/src/usage/aggregator.ts:163-169), so the *membership* is cost-based, but the *visual order* is session-based.
- Fix: Sort the Cost-by-Project chart independently by `cost` desc, or document that both charts share one session-sorted ordering.

### [P2] "Runner-scoped data" / "each has its own usage.db" is misleading
- Claim (line ~150, Limitations): "The dashboard only shows sessions that ran on the selected runner. If you have multiple runners, each has its own usage.db with only its own sessions."
- Reality: The database path is a single global `join(homedir(), ".pizzapi", "usage.db")` (packages/cli/src/usage/schema.ts:8-10), and the scanner scans every session dir under `~/.pizzapi/sessions/` plus legacy dirs with no runner filter (packages/cli/src/usage/scanner.ts:371-395). `getUsageData` aggregates all sessions in the DB with no runner/project-of-runner filter (packages/cli/src/usage/aggregator.ts:18-72). The runner's `get_usage` handler returns this whole DB (packages/cli/src/runner/daemon.ts:1804-1819). So scoping is per-machine/agentDir, not per-runner; multiple runner processes on one machine would return identical combined data.
- Fix: Rephrase to "machine-scoped" / "shares one usage.db across all runners on the same host", or add a `runner_id` column and filter.

### [P3] Anthropic rate-limit window list omits "7-day (OAuth apps)"
- Claim (line ~120): "this shows your OAuth subscription rate-limit windows (5-hour, 7-day, Opus, Sonnet, co-work)"
- Reality: The CLI prints six windows: `5-hour window`, `7-day window`, `7-day (OAuth apps)`, `7-day (Opus)`, `7-day (Sonnet)`, `7-day (co-work)` (packages/cli/src/index.ts:181-187). The doc lists five and drops "7-day (OAuth apps)".
- Fix: Add "7-day (OAuth apps)" to the list, or say "five 5h/7-day windows including Opus, Sonnet, co-work, and OAuth apps".

### [P3] "Sessions without cost data are excluded from cost averages and charts" is imprecise
- Claim (line ~154, Limitations): "Sessions without cost data are counted in session/token totals but excluded from cost averages and charts."
- Reality: Session-level cost sums ignore NULLs (`SUM(s.total_cost)`, and `avgSessionCost` uses `AVG(CASE WHEN s.total_cost IS NOT NULL ...)` — packages/cli/src/usage/aggregator.ts:39-46), so session-level totals/averages do exclude them. But the daily/byModel/byProject cost charts use `COALESCE(SUM(u.cost_usd), 0)` (aggregator.ts:96-100, 133, 156), so a no-cost session's events contribute 0, they are not strictly "excluded" from the charts.
- Fix: Say "excluded from session cost totals/averages; their events contribute 0 to daily/model/project cost charts."

## Redesign notes

- The page is well-structured and mostly maps 1:1 to real components (SummaryCards, SessionStats, CostChart, TokenChart, ModelBreakdown, ProjectBreakdown, SessionTable, PeriodSelector). No major structural rewrite needed.
- "Model Breakdown" is described as "donut chart with an accompanying table"; the table is actually a styled list of rows (packages/ui/src/components/usage-dashboard/ModelBreakdown.tsx:97-115), not a `<table>`. Cosmetic wording — consider "accompanying legend/list".
- "Project Breakdown" says "+N more to expand the full list", but the server caps the list at 20 (`LIMIT 20`, aggregator.ts:169); "full list" is at most 20. Cross-reference the Limitations cap or say "expand up to the top 20".
- "Avg Cost / Active Day" is computed in the UI from `daily` (`days.reduce(cost)/days.length`, SummaryCards.tsx:55-58), not returned by the server as a summary field; the doc describes the behavior correctly but a reader might expect it server-side. No change needed.
- The "How Data Is Collected" pipeline (JSONL → SQLite → API → Recharts) is accurately described and matches scanner/aggregator/daemon wiring; the 60s staleness trigger lives in `getData()` (packages/cli/src/usage/index.ts:47-53) and is aliased into the daemon handler (daemon.ts:64, 1809).

## Code UX opportunities

- ProjectBreakdown shares one `showAll` toggle and one session-sorted array for both charts (ProjectBreakdown.tsx:55-64). Giving "Cost by Project" its own cost-desc sort would make the chart match its label and help users spot costly projects.
- ProjectBreakdown re-sorts client-side by sessions, discarding the server's cost-desc ordering; consider having the server return both orderings or sort per-chart client-side.
- ModelBreakdown's percentage share appears only as a donut label/tooltip, not in the side list (ModelBreakdown.tsx:97-115). The doc promises "percentage share" per model; surfacing it in the list would align UI with the doc.
- SessionTable relative time silently switches from "Nd ago" to a calendar date after 30 days (SessionTable.tsx:34-41); the doc only gives "2h/3d" examples — fine, but a tooltip already covers absolute time.
- The dashboard has no "last scanned / generated at" indicator exposed to users (the payload has `generatedAt`, types.ts:4) — showing it would help users judge freshness, especially given the 60s auto-rescan behavior.