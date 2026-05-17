# Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runner-side usage analytics dashboard that processes JSONL session files into SQLite, exposes aggregated data via the existing REST API relay, and renders interactive charts in the web UI.

**Architecture:** The runner daemon scans `~/.pizzapi/agent/sessions/` JSONL files into a local SQLite database (`usage.db`). The server exposes a new REST endpoint `GET /api/runners/:id/usage` that forwards to the runner via `sendRunnerCommand()`. The web UI adds a lazy-loaded dashboard page with recharts visualizations. This also includes migrating session storage from `~/.pi/agent/` to `~/.pizzapi/agent/` by setting `piConfig.configDir` in the CLI package.json.

**Tech Stack:** Bun SQLite (`bun:sqlite`), Socket.IO (existing relay), React 19, recharts, Tailwind/shadcn

**Spec:** `docs/superpowers/specs/2026-03-23-usage-dashboard-design.md`

**Worktree:** `.worktrees/feat-usage-dashboard`

---

## File Structure

```
# New files
packages/cli/src/usage/types.ts           — Shared TypeScript types (UsageData, schema types)
packages/cli/src/usage/schema.ts           — SQLite schema creation, WAL mode, migrations
packages/cli/src/usage/scanner.ts          — JSONL parser + SQLite writer (incremental)
packages/cli/src/usage/aggregator.ts       — SQL queries → UsageData response payload
packages/cli/src/usage/index.ts            — Public API: init(), scan(), getData()
packages/cli/src/usage/scanner.test.ts     — Scanner unit tests
packages/cli/src/usage/aggregator.test.ts  — Aggregator unit tests

packages/ui/src/components/usage-dashboard/types.ts            — UI-side UsageData type
packages/ui/src/components/usage-dashboard/UsageDashboard.tsx  — Main dashboard page
packages/ui/src/components/usage-dashboard/SummaryCards.tsx     — Top stat cards
packages/ui/src/components/usage-dashboard/CostChart.tsx        — Cost over time (BarChart)
packages/ui/src/components/usage-dashboard/TokenChart.tsx       — Token usage (AreaChart)
packages/ui/src/components/usage-dashboard/ModelBreakdown.tsx   — By model (PieChart)
packages/ui/src/components/usage-dashboard/ProjectBreakdown.tsx — By project (BarChart)
packages/ui/src/components/usage-dashboard/PeriodSelector.tsx   — Time range filter

# Modified files
packages/cli/package.json                  — Add piConfig.configDir = ".pizzapi"
packages/cli/src/runner/daemon.ts          — Add migration logic + usage scanner init + handle usage command
packages/protocol/src/runner.ts            — Add usage events to protocol types
packages/server/src/routes/runners.ts      — Add GET /api/runners/:id/usage endpoint
packages/ui/package.json                   — Add recharts dependency
packages/ui/src/App.tsx (or router)        — Add /runner/:id/usage route (lazy-loaded)
```

---

## Chunk 1: Core Data Layer (CLI)

### Task 1: Config Dir Migration

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/runner/daemon.ts`

- [ ] **Step 1: Add piConfig to package.json**

In `packages/cli/package.json`, add at the top level:
```json
"piConfig": {
  "configDir": ".pizzapi"
}
```

- [ ] **Step 2: Add migration function to daemon.ts**

Add a `migrateSessionStorage()` function that checks if `~/.pi/agent/` exists and `~/.pizzapi/agent/sessions/` does not, then moves the directory. Call it early in `connectToRelay()` before usage scanner init.

```typescript
import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function migrateSessionStorage(): void {
  const oldDir = join(homedir(), ".pi", "agent");
  const newDir = join(homedir(), ".pizzapi", "agent");
  const newSessions = join(newDir, "sessions");

  if (!existsSync(oldDir) || existsSync(newSessions)) return;

  mkdirSync(newDir, { recursive: true });
  try {
    renameSync(oldDir, newDir);
    console.log(`Migrated session data from ~/.pi/agent to ~/.pizzapi/agent`);
  } catch (e: any) {
    if (e.code === "EXDEV") {
      cpSync(oldDir, newDir, { recursive: true });
      rmSync(oldDir, { recursive: true, force: true });
      console.log(`Migrated session data from ~/.pi/agent to ~/.pizzapi/agent (cross-device copy)`);
    } else {
      console.error("Failed to migrate session storage:", e);
    }
  }
}
```

- [ ] **Step 3: Verify migration works**

Test manually: create a dummy `~/.pi/agent/sessions/test/` dir, run the migration function, verify it moves.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/package.json packages/cli/src/runner/daemon.ts
git commit -m "feat: migrate session storage from ~/.pi to ~/.pizzapi"
```

---

### Task 2: Usage Types

**Files:**
- Create: `packages/cli/src/usage/types.ts`

- [ ] **Step 1: Create the shared types file**

```typescript
// packages/cli/src/usage/types.ts

/** JSONL session header (first line of every session file) */
export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

/** JSONL assistant message with usage data */
export interface UsageMessage {
  type: "message";
  id: string;
  timestamp: string;
  message: {
    role: "assistant";
    provider: string;
    model: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total: number;
      };
    };
  };
}

/** JSONL model change event */
export interface ModelChangeEvent {
  type: "model_change";
  timestamp: string;
  provider: string;
  modelId: string;
}

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
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/usage/types.ts
git commit -m "feat(usage): add shared TypeScript types"
```

---

### Task 3: SQLite Schema

**Files:**
- Create: `packages/cli/src/usage/schema.ts`

- [ ] **Step 1: Create the schema module**

```typescript
// packages/cli/src/usage/schema.ts
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

const SCHEMA_VERSION = 1;

export function getUsageDbPath(): string {
  return join(homedir(), ".pizzapi", "agent", "usage.db");
}

export function getSessionsDir(): string {
  // Check .pizzapi first (post-migration), fall back to .pi
  const pizzapiDir = join(homedir(), ".pizzapi", "agent", "sessions");
  const piDir = join(homedir(), ".pi", "agent", "sessions");
  // Return both if both exist (scanner handles dedup)
  return pizzapiDir; // Primary — scanner also checks piDir as fallback
}

export function openUsageDb(): Database {
  const dbPath = getUsageDbPath();
  mkdirSync(join(dbPath, ".."), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL for concurrent read/write
  db.run("PRAGMA journal_mode=WAL");

  const currentVersion = db.query<{ user_version: number }, []>(
    "PRAGMA user_version"
  ).get()?.user_version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    db.transaction(() => {
      if (currentVersion < 1) {
        db.run(`
          CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            cost_usd REAL,
            cost_input REAL,
            cost_output REAL,
            cost_cache_read REAL,
            cost_cache_write REAL,
            UNIQUE(session_id, timestamp, model)
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            session_name TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            message_count INTEGER DEFAULT 0,
            total_input INTEGER DEFAULT 0,
            total_output INTEGER DEFAULT 0,
            total_cache_read INTEGER DEFAULT 0,
            total_cache_write INTEGER DEFAULT 0,
            total_cost REAL,
            primary_model TEXT,
            primary_provider TEXT
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS processing_state (
            file_path TEXT PRIMARY KEY,
            last_offset INTEGER DEFAULT 0,
            last_modified INTEGER
          )
        `);

        db.run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON usage_events(timestamp)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_project ON usage_events(project)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_model ON usage_events(model)");
        db.run("CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)");
        db.run("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)");
      }

      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  return db;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/usage/schema.ts
git commit -m "feat(usage): SQLite schema with WAL mode and versioning"
```

---

### Task 4: JSONL Scanner

**Files:**
- Create: `packages/cli/src/usage/scanner.ts`
- Create: `packages/cli/src/usage/scanner.test.ts`

- [ ] **Step 1: Write scanner tests**

Create `packages/cli/src/usage/scanner.test.ts` with tests for:
- Parsing a JSONL file with session header + assistant messages → correct usage_events rows
- Reading `cwd` from session header (not directory name)
- Incremental processing: first scan processes all, second scan only new lines
- Partial final line: incomplete last line is not processed
- Malformed JSON lines are skipped without crashing
- Sessions with no cost data get NULL cost_usd
- Session name extraction from set_session_name tool calls

Use `mkdtempSync` for all temp dirs. Create sample JSONL content as string literals in the test.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/cli && bun test src/usage/scanner.test.ts
```
Expected: FAIL — scanner.ts doesn't exist yet.

- [ ] **Step 3: Implement the scanner**

Create `packages/cli/src/usage/scanner.ts`:

Key functions:
- `scanSessions(db: Database): void` — walks session directories, processes each JSONL file
- `processFile(db: Database, filePath: string, relativePath: string): void` — reads from last offset, parses lines, inserts into DB
- `parseSessionHeader(line: string): SessionHeader | null`
- `extractUsageFromLine(line: string): { usage message data } | null`
- `extractSessionName(line: string): string | null` — looks for set_session_name tool calls

The scanner:
1. Checks `processing_state` for each file (by relative path)
2. Compares file mtime — skips if unchanged
3. Opens file, seeks to `last_offset`
4. Reads lines until EOF (stopping at last complete `\n`-terminated line)
5. For each `type: "session"` line: extracts `cwd` and `id`
6. For each `type: "message"` with `role: "assistant"` and `usage`: inserts into `usage_events` (INSERT OR IGNORE)
7. After processing all lines: upserts `sessions` row with aggregated totals
8. Updates `processing_state` with new offset and mtime

Also scan both `~/.pizzapi/agent/sessions` and `~/.pi/agent/sessions` (if they exist) for backward compat.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/cli && bun test src/usage/scanner.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/usage/scanner.ts packages/cli/src/usage/scanner.test.ts
git commit -m "feat(usage): JSONL scanner with incremental processing"
```

---

### Task 5: Aggregator

**Files:**
- Create: `packages/cli/src/usage/aggregator.ts`
- Create: `packages/cli/src/usage/aggregator.test.ts`

- [ ] **Step 1: Write aggregator tests**

Create `packages/cli/src/usage/aggregator.test.ts` with tests for:
- Daily rollups: given events on 3 different days, returns 3 daily entries with correct sums
- Model breakdown: top 20 by cost, correct session counts
- Project breakdown: top 20 by cost, projectShort is last path component
- Session summary stats: avgSessionCost excludes NULL cost, avgDuration excludes NULL ended_at
- Empty DB returns zeroed summary
- Date range filtering (7d, 30d, 90d, all)

Pre-populate a test SQLite DB (in-memory or tmpdir) with known data.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/cli && bun test src/usage/aggregator.test.ts
```

- [ ] **Step 3: Implement the aggregator**

Create `packages/cli/src/usage/aggregator.ts`:

```typescript
export function getUsageData(db: Database, range: UsageRange): UsageData
```

Uses SQL queries:
- `summary`: COUNT, SUM, AVG over sessions/events with date filter
- `daily`: GROUP BY `date(timestamp/1000, 'unixepoch')` 
- `byModel`: GROUP BY model, ORDER BY cost DESC LIMIT 20
- `byProject`: GROUP BY project, ORDER BY cost DESC LIMIT 20
- `recentSessions`: ORDER BY started_at DESC LIMIT 50

Date range: compute `fromTimestamp` based on range ("7d" = now - 7*86400*1000, etc.)

- [ ] **Step 4: Run tests**

```bash
cd packages/cli && bun test src/usage/aggregator.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/usage/aggregator.ts packages/cli/src/usage/aggregator.test.ts
git commit -m "feat(usage): aggregator with daily rollups and breakdowns"
```

---

### Task 6: Public API (index.ts)

**Files:**
- Create: `packages/cli/src/usage/index.ts`

- [ ] **Step 1: Create the usage module entry point**

```typescript
// packages/cli/src/usage/index.ts
import { openUsageDb } from "./schema.js";
import { scanSessions } from "./scanner.js";
import { getUsageData } from "./aggregator.js";
import type { UsageData, UsageRange } from "./types.js";
import type { Database } from "bun:sqlite";

let db: Database | null = null;
let lastScanAt = 0;
let scanning = false;

export function initUsage(): void {
  db = openUsageDb();
  // Initial scan in background
  triggerScan();
}

export async function triggerScan(): Promise<void> {
  if (!db || scanning) return;
  scanning = true;
  try {
    scanSessions(db);
    lastScanAt = Date.now();
  } finally {
    scanning = false;
  }
}

export function getData(range: UsageRange = "90d"): UsageData | null {
  if (!db) return null;
  // Trigger scan if stale (> 1 min)
  if (Date.now() - lastScanAt > 60_000) {
    triggerScan(); // fire and forget — return current data
  }
  return getUsageData(db, range);
}

export function closeUsage(): void {
  db?.close();
  db = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/usage/index.ts
git commit -m "feat(usage): public API entry point"
```

---

## Chunk 2: Protocol & Server Relay

### Task 7: Protocol Types

**Files:**
- Modify: `packages/protocol/src/runner.ts`

- [ ] **Step 1: Add usage events to the protocol**

Add to `RunnerClientToServerEvents`:
```typescript
/** Runner responds with usage dashboard data */
usage_data: (data: {
  requestId: string;
  data: unknown; // UsageData shape — typed as unknown here to avoid protocol depending on CLI types
}) => void;

/** Runner reports a usage data error */
usage_error: (data: {
  requestId: string;
  error: string;
}) => void;
```

Add to `RunnerServerToClientEvents`:
```typescript
/** Requests usage dashboard data from the runner */
get_usage: (data: {
  requestId?: string;
  range?: string; // "7d" | "30d" | "90d" | "all"
}) => void;
```

- [ ] **Step 2: Build protocol package**

```bash
cd packages/protocol && bun run build
```

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/runner.ts
git commit -m "feat(protocol): add usage dashboard events"
```

---

### Task 8: Runner Daemon — Handle Usage Command

**Files:**
- Modify: `packages/cli/src/runner/daemon.ts`

- [ ] **Step 1: Import usage module and wire up event handler**

In `daemon.ts`, inside `connectToRelay()` after the socket is connected:

```typescript
import { initUsage, getData, closeUsage } from "../usage/index.js";

// During startup, after migrateSessionStorage():
initUsage();

// Start periodic scan (every 5 minutes)
const usageScanInterval = setInterval(() => {
  triggerScan();
}, 5 * 60 * 1000);

// Handle usage data request
socket.on("get_usage", (data) => {
  const requestId = data.requestId ?? "";
  try {
    const range = (data.range as UsageRange) || "90d";
    const usageData = getData(range);
    if (!usageData) {
      socket.emit("usage_error", { requestId, error: "Usage data not available yet — initial scan in progress" });
      return;
    }
    socket.emit("usage_data", { requestId, data: usageData });
  } catch (e: any) {
    socket.emit("usage_error", { requestId, error: e.message ?? "Unknown error" });
  }
});

// In cleanup/shutdown: clearInterval(usageScanInterval); closeUsage();
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/runner/daemon.ts
git commit -m "feat(runner): handle usage data requests"
```

---

### Task 9: Server REST Endpoint

**Files:**
- Modify: `packages/server/src/routes/runners.ts`

- [ ] **Step 1: Add GET /api/runners/:id/usage endpoint**

Follow the existing pattern in `runners.ts` (e.g., how `sandbox_get_status` works with `sendRunnerCommand`):

```typescript
// GET /api/runners/:id/usage?range=7d|30d|90d|all
app.get("/api/runners/:id/usage", requireAuth, async (c) => {
  const runnerId = c.req.param("id");
  const range = c.req.query("range") || "90d";
  
  try {
    const result = await sendRunnerCommand(runnerId, {
      type: "get_usage",
      range,
    }, 30_000); // 30s timeout for initial scan
    
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
```

Also add `usage_data` and `usage_error` to the `sendRunnerCommand` response handling in the runner namespace handler (similar to how `file_result` is handled — correlate by `requestId`).

- [ ] **Step 2: Test the endpoint**

```bash
# Start dev server and runner, then:
curl -H "Authorization: Bearer <token>" http://localhost:7492/api/runners/<runnerId>/usage?range=7d
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/runners.ts packages/server/src/ws/namespaces/runner.ts
git commit -m "feat(server): add usage dashboard REST endpoint"
```

---

## Chunk 3: Web UI Dashboard

### Task 10: Add recharts Dependency

**Files:**
- Modify: `packages/ui/package.json`

- [ ] **Step 1: Install recharts**

```bash
cd packages/ui && bun add recharts
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/package.json bun.lockb
git commit -m "feat(ui): add recharts for usage dashboard charts"
```

---

### Task 11: UI Types

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/types.ts`

- [ ] **Step 1: Create UI-side types**

Copy the `UsageData` and `UsageRange` types from `packages/cli/src/usage/types.ts`. These are the same shape — the UI just needs to know what the API returns. Keep them in sync manually (or consider moving to a shared package later).

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/types.ts
git commit -m "feat(ui): add usage dashboard types"
```

---

### Task 12: Period Selector

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/PeriodSelector.tsx`

- [ ] **Step 1: Create the period selector component**

Pill-button row with `7d | 30d | 90d | All`. Uses existing shadcn button styling with active state.

```tsx
interface PeriodSelectorProps {
  value: UsageRange;
  onChange: (range: UsageRange) => void;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/PeriodSelector.tsx
git commit -m "feat(ui): period selector component"
```

---

### Task 13: Summary Cards

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/SummaryCards.tsx`

- [ ] **Step 1: Create the summary cards component**

Four stat cards in a responsive grid. Each card shows a big number, label, and optional trend.

```tsx
interface SummaryCardsProps {
  summary: UsageData["summary"];
  daily: UsageData["daily"];
}
```

Cards: Total Cost, Sessions, Total Tokens, Avg Cost/Day.

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/SummaryCards.tsx
git commit -m "feat(ui): summary stat cards"
```

---

### Task 14: Cost Chart

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/CostChart.tsx`

- [ ] **Step 1: Create the cost over time chart**

Recharts `BarChart` with stacked bars for cost components (input, output, cache_read, cache_write). Dark theme colors.

```tsx
interface CostChartProps {
  daily: UsageData["daily"];
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/CostChart.tsx
git commit -m "feat(ui): cost over time chart"
```

---

### Task 15: Token Chart

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/TokenChart.tsx`

- [ ] **Step 1: Create the token usage chart**

Recharts `AreaChart` with stacked areas for input, output, cache_read, cache_write tokens.

```tsx
interface TokenChartProps {
  daily: UsageData["daily"];
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/TokenChart.tsx
git commit -m "feat(ui): token usage chart"
```

---

### Task 16: Model Breakdown

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/ModelBreakdown.tsx`

- [ ] **Step 1: Create the model breakdown chart**

Recharts `PieChart` showing cost distribution by model. Include a legend with model names, costs, and percentages.

```tsx
interface ModelBreakdownProps {
  byModel: UsageData["byModel"];
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/ModelBreakdown.tsx
git commit -m "feat(ui): model breakdown chart"
```

---

### Task 17: Project Breakdown

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/ProjectBreakdown.tsx`

- [ ] **Step 1: Create the project breakdown chart**

Horizontal recharts `BarChart` showing session count and cost per project (using `projectShort` labels).

```tsx
interface ProjectBreakdownProps {
  byProject: UsageData["byProject"];
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/ProjectBreakdown.tsx
git commit -m "feat(ui): project breakdown chart"
```

---

### Task 18: Main Dashboard Page

**Files:**
- Create: `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx`

- [ ] **Step 1: Create the main dashboard component**

Composes all sub-components. Handles:
- Data fetching via `fetch('/api/runners/${runnerId}/usage?range=${range}')`
- Loading skeleton state
- Error state (runner offline, scan not ready)
- Empty state (no sessions)
- Period selector changes trigger new API request

```tsx
interface UsageDashboardProps {
  runnerId: string;
}
```

Layout order: PeriodSelector → SummaryCards → CostChart → TokenChart → ModelBreakdown → ProjectBreakdown.

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/usage-dashboard/UsageDashboard.tsx
git commit -m "feat(ui): main usage dashboard page"
```

---

### Task 19: Route Wiring

**Files:**
- Modify: `packages/ui/src/App.tsx` (or router file)

- [ ] **Step 1: Find the router and add the usage route**

Look at the existing route structure (e.g., how `/runner/:id` is defined). Add:

```tsx
const UsageDashboard = React.lazy(() => import("./components/usage-dashboard/UsageDashboard"));

// In the router:
<Route path="/runner/:runnerId/usage" element={
  <Suspense fallback={<LoadingSkeleton />}>
    <UsageDashboard />
  </Suspense>
} />
```

Also add a "Usage" navigation link/tab in the runner detail view.

- [ ] **Step 2: Verify the route loads**

Start dev server (`bun run dev`), navigate to `/runner/<id>/usage`, verify the dashboard renders.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/App.tsx  # or wherever the router lives
git commit -m "feat(ui): wire up usage dashboard route with lazy loading"
```

---

## Chunk 4: Integration & Polish

### Task 20: End-to-End Verification

- [ ] **Step 1: Build everything**

```bash
bun run build
```

- [ ] **Step 2: Run all tests**

```bash
bun run test
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Manual E2E test**

1. Start the runner daemon
2. Navigate to the usage dashboard in the web UI
3. Verify: data loads, charts render, period selector works
4. Verify: scanner processes existing JSONL files correctly

- [ ] **Step 5: Fix any issues found**

---

### Task 21: Final Push

- [ ] **Step 1: Commit any remaining changes**

- [ ] **Step 2: Push**

```bash
git push -u origin feat/usage-dashboard
```
