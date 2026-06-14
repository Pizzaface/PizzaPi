# Usage Dashboard — Design Spec

**Date:** 2026-03-23  
**Status:** Draft (rev 3 — post-review)  
**Branch:** `feat/usage-dashboard`

## Overview

A runner-side usage analytics dashboard for PizzaPi. The runner processes its local JSONL session files into a SQLite database, exposes aggregated usage data via the WebSocket relay, and the web UI renders interactive charts and summary cards.

This feature also includes migrating PizzaPi's config directory from `~/.pi` to `~/.pizzapi`, consolidating all PizzaPi state under a single directory.

## Goals

- Show token usage, costs, model breakdown, session counts, and per-project activity
- Process data entirely on the runner (where the JSONL files live)
- Deliver data to the web UI through the existing runner → server → browser relay
- Migrate session storage from `~/.pi/agent/` to `~/.pizzapi/agent/`

## Non-Goals

- Real-time streaming of token counts during active sessions (future)
- Server-side usage aggregation across multiple runners (future)
- Billing or cost alerts (future)
- Per-user usage breakdown (PizzaPi runners are single-user)

---

## Part 1: Config Directory Migration

### Change

Add `piConfig` to PizzaPi CLI's `package.json`:

```json
{
  "piConfig": {
    "configDir": ".pizzapi"
  }
}
```

This makes the upstream `pi` library store sessions, settings, and auth under `~/.pizzapi/agent/` instead of `~/.pi/agent/`. The upstream `pi` library reads `pkg.piConfig?.configDir` to determine `CONFIG_DIR_NAME` (defaulting to `".pi"`).

### Migration Logic

On CLI startup (in the runner daemon init path):

1. Check if `~/.pi/agent/sessions/` exists AND `~/.pizzapi/agent/sessions/` does not
2. If both conditions are true:
   a. Ensure `~/.pizzapi/agent/` parent directory exists
   b. Attempt `fs.rename("~/.pi/agent", "~/.pizzapi/agent")` (atomic on same filesystem)
   c. If rename fails (EXDEV cross-device), fall back to recursive copy then delete
3. Log the migration: `"Migrated session data from ~/.pi/agent to ~/.pizzapi/agent"`
4. If `~/.pizzapi/agent/` already exists, skip (migration already done)
5. If `~/.pi/agent/` doesn't exist, skip (fresh install)

### Files Affected

- `packages/cli/package.json` — add `piConfig.configDir`
- Runner startup path — migration check

### Risks

- Users running standalone `pi` alongside PizzaPi will have separate session stores after migration. This is intentional — PizzaPi is a separate product.
- A failed partial move (cross-filesystem copy interrupted) could leave data in an inconsistent state. Mitigation: copy first, only delete source after verifying the copy completed. If the copy fails partway, the source remains intact.

---

## Part 2: Usage Database

### Location

`~/.pizzapi/agent/usage.db` (SQLite, using Bun's built-in `bun:sqlite`)

### Schema

```sql
-- WAL mode for concurrent read/write (scanner writes while aggregator reads)
PRAGMA journal_mode=WAL;

-- Schema version for future migrations
PRAGMA user_version = 1;

-- Per-message usage records (one row per LLM response in a session)
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  timestamp INTEGER NOT NULL,       -- unix milliseconds
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_usd REAL,                    -- NULL = unknown cost, 0 = free
  cost_input REAL,                  -- per-component cost breakdown
  cost_output REAL,
  cost_cache_read REAL,
  cost_cache_write REAL,
  UNIQUE(session_id, timestamp, model)  -- idempotent inserts via INSERT OR IGNORE
);

-- Session-level summary (one row per session JSONL file)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- UUID from filename
  project TEXT NOT NULL,            -- cwd from session header
  session_name TEXT,                -- extracted from set_session_name tool call, if present
  started_at INTEGER NOT NULL,      -- unix ms (from session header timestamp)
  ended_at INTEGER,                 -- unix ms (last message timestamp), NULL if no end detected
  message_count INTEGER DEFAULT 0,  -- LLM response count
  total_input INTEGER DEFAULT 0,
  total_output INTEGER DEFAULT 0,
  total_cache_read INTEGER DEFAULT 0,
  total_cache_write INTEGER DEFAULT 0,
  total_cost REAL,                  -- NULL if no cost data, 0 if free
  primary_model TEXT,               -- most-used model by message count
  primary_provider TEXT
);

-- Incremental processing checkpoints
CREATE TABLE processing_state (
  file_path TEXT PRIMARY KEY,       -- relative to sessions dir
  last_offset INTEGER DEFAULT 0,   -- byte offset (always at a line boundary)
  last_modified INTEGER            -- file mtime for change detection
);

-- Indexes for common queries
CREATE INDEX idx_events_timestamp ON usage_events(timestamp);
CREATE INDEX idx_events_project ON usage_events(project);
CREATE INDEX idx_events_model ON usage_events(model);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_project ON sessions(project);
```

**Design decisions:**
- **WAL mode** enabled for concurrent read/write — scanner writes in background while aggregator reads on-demand. Without WAL, reads during the initial backfill (10-30 seconds) would get `SQLITE_BUSY`.
- **`user_version = 1`** — enables future schema migrations via `PRAGMA user_version` check on open.
- `cost_usd` is `REAL` nullable: `NULL` = no cost data (self-hosted, older sessions), `0` = genuinely free. The aggregator uses `COALESCE(cost_usd, 0)` for sums but can distinguish "unknown" from "zero" when displaying.
- Per-component cost columns (`cost_input`, `cost_output`, `cost_cache_read`, `cost_cache_write`) support the stacked cost chart without re-deriving from token counts and pricing.
- `total_tokens` column removed — it's derivable from `input + output + cache_read + cache_write` and storing it risks drift.
- **`UNIQUE(session_id, timestamp, model)`** on `usage_events` — makes inserts idempotent via `INSERT OR IGNORE`. Guards against duplicate rows if `processing_state` is ever lost or reset.
- **`primary_model`** determined by message count (most messages using that model). Simple and predictable.

### JSONL Parsing

Each JSONL file starts with a `type: "session"` header line containing the actual `cwd`:

```typescript
// First line — session header with actual cwd path
interface SessionHeader {
  type: "session";
  version: number;
  id: string;           // session UUID
  timestamp: string;    // ISO timestamp
  cwd: string;          // actual filesystem path — use this, not the directory name
}

// type: "message" with role: "assistant" and usage data
interface UsageEntry {
  type: "message";
  timestamp: string;
  message: {
    role: "assistant";
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
  };
}
```

**Project path source:** The `cwd` field from the session header is the authoritative project path. Directory names use a lossy encoding (`--path-segments--` with `-` replacing `/`) that's ambiguous for paths containing hyphens. We **never decode directory names** — we read `cwd` from the first JSONL line instead.

### Session Identification

JSONL filenames encode timestamp and UUID:
```
2026-03-22T23-59-46-714Z_1576079c-23b2-4de6-8d8c-09e17b350ba3.jsonl
```

The session UUID and timestamp are also available in the `type: "session"` header line, so filename parsing is a fallback only.

### Session Names

Session names (set via the `set_session_name` tool) appear in the JSONL as tool call arguments within assistant messages. The scanner extracts these by looking for tool calls to `set_session_name` or `mcp_session_name` and reading the `name` argument. If no session name is found, the session is displayed with project name + timestamp.

---

## Part 3: Runner-Side Processing

### Scanner Module

Location: `packages/cli/src/usage/scanner.ts`

**Responsibilities:**
1. Walk `~/.pizzapi/agent/sessions/*/` directories
2. For each `.jsonl` file, check `processing_state` for existing offset
3. If file mtime > stored mtime OR no record exists, read from last offset
4. Parse each line, extract usage events from assistant messages
5. Batch-insert into `usage_events`, upsert into `sessions`
6. Update `processing_state` with new offset and mtime

**Partial line handling:** When reading from an offset, the scanner reads until the last complete `\n`-terminated line. If the final bytes don't end with `\n`, they're a partial line (active session still writing). The scanner stores the offset at the last `\n` boundary, not at the end of the read buffer. On the next scan, it re-reads from that boundary and picks up the completed line.

**Malformed line handling:** Lines that fail `JSON.parse` are skipped and logged (debug level). The offset still advances past them — they won't be retried.

**When it runs:**
- On runner startup (full scan, catches up on any unprocessed data)
- Every 5 minutes during runtime (lightweight — only checks mtime changes)
- Triggered on-demand when dashboard data is requested (if last scan > 1 minute ago)

**Performance considerations:**
- Initial backfill of ~665MB / ~2,000 files may take 10-30 seconds. This runs in the background and doesn't block the runner from accepting sessions.
- Subsequent incremental scans should complete in <1 second (only new data)
- Use SQLite transactions for batch inserts (1 transaction per file)
- Read files with `Bun.file().stream()` for memory efficiency

### Usage Aggregator Module

Location: `packages/cli/src/usage/aggregator.ts`

**Responsibilities:**
- Query `usage_events` and `sessions` tables
- Produce the API response payload with daily rollups and session summaries
- Apply a default date range cap (last 90 days) to keep payload size bounded. Client can request "all" explicitly.

**API Response Shape:**

```typescript
interface UsageData {
  generatedAt: string;                    // ISO timestamp
  dateRange: { from: string; to: string }; // actual range of returned data
  totalDateRange: { from: string; to: string }; // full range available in DB
  
  // Summary totals (for the requested date range)
  summary: {
    totalSessions: number;
    totalCost: number;                    // sum of known costs (excludes NULL)
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    avgSessionCost: number;
    avgSessionTokens: number;
    avgSessionDurationMs: number | null;  // null if no sessions have ended_at
    sessionsWithCost: number;             // how many sessions had cost data
  };
  
  // Daily rollups (one entry per day with data, within date range)
  daily: Array<{
    date: string;                         // YYYY-MM-DD
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
  
  // By model breakdown (top 20 by cost, within date range)
  byModel: Array<{
    provider: string;
    model: string;
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  
  // By project breakdown (top 20 by cost, within date range)
  byProject: Array<{
    project: string;
    projectShort: string;                 // last path component
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  
  // Recent sessions list (last 50 within date range)
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
```

**Payload size bounds:** With a 90-day default range, the payload contains at most:
- 90 daily rollup entries
- 20 model breakdown entries
- 20 project breakdown entries
- 50 recent session entries
This keeps the payload well under 100KB in all realistic scenarios.

### WebSocket Integration

The runner communicates with the PizzaPi server via WebSocket (Socket.IO). Add new events:

**Request:** `usage:getData` (from server, forwarding UI request)  
- Payload: `{ requestId: string; range?: "7d" | "30d" | "90d" | "all" }` (default range: `"90d"`)
- `requestId` is a UUID generated by the UI to correlate request → response

**Success response:** `usage:data` (to server, with `{ requestId: string; data: UsageData }`)

**Error response:** `usage:error` (to server, with `{ requestId: string; error: string }`)  
- Sent when: DB is locked, scanner hasn't completed first run yet, or unexpected error
- UI shows a user-friendly error message

---

## Part 4: Server Relay

### Changes

The PizzaPi server needs to:
1. Accept `usage:getData` from authenticated web UI clients
2. Forward it to the target runner via the existing relay WebSocket
3. Forward the runner's `usage:data` or `usage:error` response back to the requesting UI client

This follows the same pattern as `runner:getInfo`, `session:create`, etc. No new server-side storage needed.

### Auth

Same auth as existing runner operations — the user must be authenticated and authorized to view the runner.

---

## Part 5: Web UI Dashboard

### Route

`/runner/:runnerId/usage` — accessible from the runner detail page. Add a "Usage" tab/link alongside the existing session list.

### Components

**File:** `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx`

**Dependencies:** Add `recharts` to `packages/ui/package.json`

> **Bundle size note:** recharts adds ~150KB gzipped to the bundle. This is acceptable because: (a) the dashboard is a separate route and can be code-split / lazy-loaded, (b) the alternative (hand-rolled SVG charts) would be significantly more implementation effort for worse results, (c) recharts is tree-shakeable — we only import the chart types we use.

### Layout (Mobile-First)

#### Summary Cards Row
Four stat cards in a responsive grid (1 col mobile, 2 col tablet, 4 col desktop):
- **Total Cost** — `$42.50` with trend indicator
- **Sessions** — `312` total sessions in period
- **Tokens** — `1.2M` total tokens (input + output)
- **Avg Cost/Day** — `$4.10` average daily cost

#### Period Selector
Pill buttons: `7d | 30d | 90d | All`  
Sends the selected range to the runner via `usage:getData`. The runner returns data for just that range.

#### Cost Over Time Chart
`recharts.BarChart` — stacked bars per day with cost breakdown (input, output, cache_read, cache_write cost segments). X-axis: dates. Y-axis: USD.

#### Token Usage Over Time Chart  
`recharts.AreaChart` — stacked areas for input, output, cache_read, cache_write tokens. Shows the composition of token usage.

#### Usage by Model
`recharts.PieChart` or horizontal `BarChart` — breakdown of cost or tokens by model. Shows which models consume the most resources.

#### Sessions by Project
Horizontal `recharts.BarChart` — shows session count and cost per project (using the short project name, i.e., last path component).

#### Average Session Stats
Simple card with:
- Avg duration (from started_at to ended_at, excluding sessions where ended_at is NULL)
- Avg tokens per session
- Avg cost per session (excluding sessions with NULL cost)
- Avg turns per session (message count)

### Styling

- Follow existing PizzaPi dark theme (zinc/slate backgrounds, colored accents)
- Recharts supports custom theming — use PizzaPi's color palette
- Cards use existing shadcn `Card` component
- Responsive: single-column on mobile, expanding at `sm:` and `md:` breakpoints
- All interactive elements ≥ 44px touch targets
- Dashboard route is lazy-loaded (`React.lazy`) to avoid loading recharts on every page

### Data Loading

1. Component mounts → dispatches `usage:getData` via existing WebSocket connection
2. Shows loading skeleton while waiting
3. Caches response in React state (no persistence needed — fresh on each visit)
4. Period selector triggers a new `usage:getData` request with the selected range
5. Error state if runner is offline, data unavailable, or `usage:error` received
6. Empty state with helpful message if no sessions exist yet

---

## File Structure

```
packages/cli/src/usage/
  scanner.ts          — JSONL parser + SQLite writer
  aggregator.ts       — Query builder for API response
  schema.ts           — SQLite schema creation + migrations
  types.ts            — Shared TypeScript types
  index.ts            — Public API (init, scan, getData)

packages/ui/src/components/usage-dashboard/
  UsageDashboard.tsx  — Main dashboard page component
  SummaryCards.tsx     — Top-level stat cards
  CostChart.tsx       — Cost over time (BarChart)
  TokenChart.tsx       — Token usage over time (AreaChart)
  ModelBreakdown.tsx   — Usage by model (PieChart)
  ProjectBreakdown.tsx — Sessions by project (BarChart)
  SessionStats.tsx     — Average session statistics
  PeriodSelector.tsx   — Time period filter pills
  types.ts            — Shared UI types for usage data
```

---

## Testing Strategy

### Scanner Tests (`packages/cli/src/usage/scanner.test.ts`)
- Parse sample JSONL files with known usage data
- Verify correct extraction of usage events
- Verify `cwd` is read from session header (not decoded from directory name)
- Test incremental processing (resume from byte offset at line boundary)
- Test partial line handling (incomplete final line is not processed until complete)
- Test handling of malformed JSONL lines (skip gracefully, advance offset)
- Test sessions with missing cost data (NULL cost vs zero cost)
- All tests use `mkdtempSync` for temp dirs — no real home directory access

### Aggregator Tests (`packages/cli/src/usage/aggregator.test.ts`)
- Given a pre-populated SQLite DB, verify correct daily rollups
- Verify model and project breakdowns (top 20 cap)
- Verify session summary generation
- Verify cost aggregation correctly handles NULL vs 0 costs
- Verify avgSessionDurationMs excludes sessions with NULL ended_at
- Edge cases: empty DB, single session, sessions spanning midnight

### WebSocket Round-Trip Test
- Verify `usage:getData` event is registered and forwarded by the relay
- Verify `usage:data` response reaches the requesting client
- Verify `usage:error` is sent when scanner hasn't initialized yet

### UI Tests
- Component renders without crashing with mock data
- Period selector triggers new data request
- Empty state renders when no data available
- Error state renders on `usage:error`

---

## Documentation Updates

Per AGENTS.md requirements, the following docs pages need creation/updates:

| Page | Change |
|------|--------|
| `reference/architecture.mdx` | Add usage dashboard to architecture overview |
| `running/runner-daemon.mdx` | Document usage scanning behavior and usage.db |
| New: `features/usage-dashboard.mdx` | Full feature documentation |

---

## Migration Path

1. **Scanner resilience:** On startup, scanner checks both `~/.pi/agent/sessions` and `~/.pizzapi/agent/sessions` and processes whichever exists (or both, deduplicating by session ID)
2. **Config dir change:** Rolled out in the same release — migration runs on first startup
3. **Post-migration:** Scanner only checks `~/.pizzapi/agent/sessions`

---

## Resolved Questions

1. **Project path decoding:** Use `cwd` from the `type: "session"` header line in each JSONL file. Never decode from directory names (lossy encoding).
2. **Session names:** Extract from `set_session_name` tool calls in the JSONL. Fall back to project + timestamp if not found.
3. **Cost data gaps:** Use nullable `cost_usd` — NULL means "unknown" (not "free"). Aggregator reports `sessionsWithCost` count so the UI can show "cost data available for X of Y sessions."
4. **Payload size:** Default to 90-day range, cap breakdowns at top 20, recent sessions at 50. Client requests specific ranges.

## Open Questions

1. **Retention/pruning:** Should we prune old usage data from SQLite after N days? The JSONL files themselves have their own retention. For now, keep everything.
2. **Multi-runner aggregation:** When a user has multiple runners, should the UI show a combined dashboard? Deferred — v1 shows per-runner.
