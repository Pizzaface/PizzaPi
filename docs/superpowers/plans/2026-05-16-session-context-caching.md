# Session Context & Caching Insights — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SpaceSniffer-style context usage treemap and cache efficiency metrics to PizzaPi — as a live collapsible panel in the SessionViewer and a drill-down Session Inspector page from the Usage Dashboard.

**Architecture:** An ExtensionProvider (`session-analyzer`) on the runner daemon parses JSONL session files, reconstructs context blocks, and caches to SQLite. Data is served via a **runner command** (`get_session_analysis`) — same pattern as `get_usage`. The UI has two consumers: a collapsible React treemap panel in the SessionViewer (polls the command API), and a full-page Session Inspector view (drill-down from Usage Dashboard). Both use the same `GET /api/runners/:id/analysis/:sessionId` endpoint.

**Tech Stack:** TypeScript, Bun, React 19, TailwindCSS v4, PizzaPi ExtensionProvider + ServiceHandler infrastructure

**Spec:** `docs/superpowers/specs/2026-05-16-session-context-caching-insights-design.md`

**Implementation Deviations from Spec:**
- **No provider panel iframe**: Instead of an iframe, the live panel is a React component (`SessionAnalyzerPanel`) that polls the same runner command API as the inspector. This avoids the provider→UI panel transport gap.
- **No push triggers (v1)**: Both panel and inspector use polling. Push triggers deferred to v2.
- **No URL route**: Inspector uses in-app state-based view.
- **No incremental parsing**: Always reads full JSONL per analysis pass.
- **Runner command for data**: Inspector and panel both fetch via `GET /api/runners/:id/analysis/:sessionId` → runner command `get_session_analysis` → provider DB query.
- **`contextWindow` from model registry**: The analyzer accepts `contextWindows: Map<string, number>` (keyed by `provider:modelId`). For each turn, it looks up the model active at that turn and gets the corresponding window. If a turn's model has no known window, utilization is null for that turn. The provider resolves model info from the runner's model registry during analysis.

**Key Implementation Decisions (from review):**
- Provider source lives in `packages/cli/src/providers/session-analyzer/` for development. For local dev, symlink to `~/.pizzapi/providers/session-analyzer/`. Production packaging TBD (separate task).
- Analysis always reads the **full JSONL** (no incremental suffix-only parsing). Mtime-based revalidation avoids redundant work.
- **Transport path**: The inspector fetches data via a **runner command** (`get_session_analysis`), same pattern as `get_usage` the UsageDashboard already uses. The provider pre-computes and caches the analysis; the runner command queries the provider's DB. This avoids needing new provider→UI transport plumbing.
- Panel is a **React component** (`SessionAnalyzerPanel`) that polls the runner command API. No iframe or provider panel transport needed.
- Inspector uses a `SessionInspector` view rendered in-app (state-based, not URL routing).
- Push triggers are deferred to v2; v1 uses polling-only for the live panel.
- `contextWindow` is resolved from the **runner's model registry** at analysis time, keyed per `provider:modelId`. The analyzer accepts `contextWindows: Map<string, number>` to handle mixed-model sessions correctly.

---

## Prerequisites (must be done first)

### Pre-1: Add `get_session_analysis` runner command

This is the data transport path. Follow the exact same pattern as `get_usage`:

**Files to modify:**
- `packages/protocol/src/runner.ts` — add command type and response type
- `packages/cli/src/runner/daemon.ts` — handle `get_session_analysis` command, query provider db
- `packages/server/src/ws/namespaces/runner.ts` — route command to runner, return response
- `packages/server/tests/harness/mock-runner.ts` — mock for tests

**Flow:**
1. UI calls `GET /api/runners/:runnerId/analysis/:sessionId`
2. Server routes to runner namespace handler (same as `get_usage` at `packages/server/src/routes/runners.ts:1076`)
3. Handler sends `{ type: "get_session_analysis", sessionId }` to runner
4. Runner daemon queries provider's SQLite DB, returns `SessionAnalysis`
5. Server returns JSON to UI

### Pre-2: Provider installation (dev only)

```bash
mkdir -p ~/.pizzapi/providers
ln -s "$(pwd)/packages/cli/src/providers/session-analyzer" ~/.pizzapi/providers/session-analyzer
```

One-time dev setup. Not in build scripts. Tests use temp dirs.

---

## Chunk 1: Core Analyzer Library

### Task 1.1: Shared types

**Files:**
- Create: `packages/cli/src/providers/session-analyzer/types.ts`

Copy types verbatim from spec. No changes needed. Verify compiles. Commit.

### Task 1.2: JSONL parser with byte-safe reading

**Files:**
- Create: `packages/cli/src/providers/session-analyzer/parser.ts`
- Create: `packages/cli/src/providers/session-analyzer/parser.test.ts`

Key design decisions:
- `parseJsonlEntries(content: string)` — parses full JSONL string, returns `ParsedEntry[]`. Skips malformed lines, but stops at incomplete trailing line (no `\n`). Returns `{ entries, bytesConsumed, hasTrailingPartial }`.
- Byte offsets tracked via `Buffer.from(content, "utf-8").length` comparisons, not string `.length`.
- Test coverage: valid JSONL, malformed lines, incomplete trailing line, empty content, only session header, compaction entries, branch_summary entries, custom_message entries, model_change entries.

TDD: write failing test → implement → verify pass → commit.

### Task 1.3: Context reconstruction

**Files:**
- Create: `packages/cli/src/providers/session-analyzer/analyzer.ts`
- Create: `packages/cli/src/providers/session-analyzer/analyzer.test.ts`

Key design decisions (fixing review issues):
- **Full file input**: `reconstructContext(entries: ParsedEntry[], leafId: string, contextWindows?: Map<string, number>)` takes all entries and a map of model→contextWindow pairs.
- **Turn grouping**: Walk the active path from leaf→root. Collect assistant messages in order. Each assistant message = one turn block. Non-assistant messages between two assistants are part of that turn (for subBlocks estimation).
- **Model tracking**: Track model from `model_change` entries. Apply model changes at the correct turn index. Walk the path in order, building a `Map<number, Model>` keyed by turn index before the block loop.
- **Compaction skip ranges**: Walk path leaf→root. When hitting a `CompactionEntry`, collect the skip range from `firstKeptEntryId` up to the compaction entry. Apply skips when collecting the active path.
- **Compaction `estimatedTokensAfter`**: After building all blocks, for each compaction, find the first **non-separator turn block** whose entry appears **after** the compaction in the active path (not just any turn block).
- **`contextWindow` handling**: If `contextWindow` is undefined, `contextUtilization` is null. Do not hardcode a default. The provider obtains `contextWindow` from the session's model info (from `onSessionStart` event or stored metadata).
- **Cache savings**: Use a pricing table per provider/model. For v1, only support Anthropic (hardcoded: input=$3/MTok, cache_read=$0.30/MTok). Savings = `Σ cacheReadTokens * (inputPrice - cacheReadPrice)`. If costs are missing, return null. If model is non-Anthropic, return null.
- **subBlocks estimation**: Only consider entries within the current turn (from turn's user message through to the assistant, including any tool results). Estimate from content-length ratios within that scope.

TDD: write all edge case tests from spec → implement → verify → commit.

---

## Chunk 2: Provider Implementation

### Task 2.1: SQLite cache layer

**Files:**
- Create: `packages/cli/src/providers/session-analyzer/db.ts`
- Create: `packages/cli/src/providers/session-analyzer/db.test.ts`

Two tables: `session_analysis (session_id, analysis_json, updated_at)` and `processing_state (session_id, last_mtime_ms)`. Store only mtime for revalidation (no byte offset needed since we always re-read full JSONL).

TDD → commit.

### Task 2.2: ExtensionProvider

**Files:**
- Create: `packages/cli/src/providers/session-analyzer/index.ts`

Implementation notes:
- Import types from `../../providers/types.js`
- Capabilities: `["lifecycle", "context"]` (no `ui-panel` or `metadata` since we use runner command transport)
- `init(ctx)`: Open SQLite DB at configurable path (default: `~/.pizzapi/provider-data/session-analyzer/`)
- `onTurnEnd`: Read full session JSONL, parse all entries, find leaf ID, resolve per-model contextWindows from model registry, call `reconstructContext(entries, leafId, contextWindows)`, save to DB
- `onSessionClose`: Same as `onTurnEnd` for final flush
- `onBeforeAgentStart`: Inject cache efficiency hint per spec
- Expose method `getAnalysis(db, sessionId): SessionAnalysis | null` for the daemon's `get_session_analysis` handler to query (method is on the provider class, not via metadata capability)

TDD: write provider integration test → commit.

---

## Chunk 3: UI — Live Panel

### Task 3.1: React treemap panel component

**Files:**
- Create: `packages/ui/src/components/session-viewer/SessionAnalyzerPanel.tsx`

The panel is a React component (not an iframe) that:
- Polls `GET /api/runners/:runnerId/analysis/:sessionId` every 12s
- Shows collapsed state: sparkline + cache hit rate + est. savings + peak + compaction count
- Shows expanded state: CSS/SVG treemap (same layout algorithm as spec)
- Has "Approximate" disclaimer
- Handles null/loading/error states
- ~280px tall when expanded

### Task 3.2: Toggle button in SessionViewer

**Files:**
- Modify: `packages/ui/src/components/SessionViewer.tsx`

Add a toggle button next to `ContextDonut` (~line 1538). When toggled, renders `SessionAnalyzerPanel` below the header.

Commit.

---

## Chunk 4: UI — Session Inspector

### Task 4.1: Session Inspector component

**Files:**
- Create: `packages/ui/src/components/session-inspector/SessionInspector.tsx`
- Create: `packages/ui/src/components/session-inspector/types.ts`
- Create: `packages/ui/src/components/session-inspector/formatters.ts`
- Create: `packages/ui/src/components/session-inspector/Treemap.tsx`
- Create: `packages/ui/src/components/session-inspector/CostBreakdown.tsx`
- Create: `packages/ui/src/components/session-inspector/CompactionLog.tsx`
- Create: `packages/ui/src/components/session-inspector/TurnList.tsx`

The `SessionInspector` is a full-page React component. It fetches analysis data via the server API route that proxies to the runner command:
```
GET /api/runners/:runnerId/analysis/:sessionId
```
(requires `runnerId` and `sessionId` — same pattern as Usage Dashboard)
- Renders header with session name, model, cost, cache hit rate hero numbers
- Left 60%: SVG-based treemap (React component, not iframe)
- Right 40%: tabbed detail panels (CostBreakdown, CompactionLog, TurnList, ModelBreakdown)
- Null-safe throughout — handles missing cost, unknown context window, empty sessions

Sub-components:
- **Treemap.tsx**: SVG slice-and-dice treemap, same algorithm as panel but in React
- **CostBreakdown.tsx**: Simple bar chart showing input vs cache_read vs output costs. Shows "Cost data unavailable" if all costs null.
- **CompactionLog.tsx**: Table of compaction events
- **TurnList.tsx**: Sortable table of turns
- **ModelBreakdown.tsx**: Table of models used (optional, can be combined with TurnList)

Commit.

### Task 4.2: Wire SessionTable → Inspector, server route

**Files:**
- Modify: `packages/server/src/routes/runners.ts` — add `GET /api/runners/:id/analysis/:sessionId` (proxy to runner command)
- Modify: `packages/ui/src/components/usage-dashboard/SessionTable.tsx`
- Modify: `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx`
- Modify: `packages/ui/src/components/RunnerDetailPanel.tsx`

Steps:
1. **Server route**: Add `GET /api/runners/:id/analysis/:sessionId` to `runners.ts`. Proxies to `sendRunnerCommand(runnerId, { type: "get_session_analysis", sessionId })`. Same pattern as `GET /api/runners/:id/usage` at line 1076.
2. Add `onInspectSession?: (sessionId: string) => void` prop to `SessionTable`
3. Add "Inspect" button to `SessionTable` (properly typed column, no SortKey hack)
4. `UsageDashboard` passes `onInspectSession` through to `SessionTable`
5. `RunnerDetailPanel` manages an `inspectorSessionId` state. When set and on the "usage" tab, renders `SessionInspector` instead of `UsageDashboard`. Passes `runnerId` and `sessionId`.

Commit.

### Task 4.3: Provider installation (dev only)

For local development, the provider must be discoverable at `~/.pizzapi/providers/session-analyzer/`. Document the symlink approach:
```bash
mkdir -p ~/.pizzapi/providers
ln -s "$(pwd)/packages/cli/src/providers/session-analyzer" ~/.pizzapi/providers/session-analyzer
```

This is NOT added to `bun run build`. It's a one-time dev setup step documented in the PR description. CI tests that need provider loading use temp directories.

Verify: start daemon, check that provider loads and panel is announced.

Commit.

---

## Chunk 5: Tests & CI

### Task 5.1: Analyzer edge case tests

Complete the test matrix from the spec:
- Split-turn compaction
- Repeated compactions  
- Branch summaries in path
- Custom message entries
- No assistant messages (empty session)
- Mixed models
- Missing cost data
- Unknown context window
- UTF-8 content in messages (offset correctness)

### Task 5.2: Provider integration test

Test provider loads: `init()`, `onTurnEnd()` triggers analysis, `getAnalysis()` returns cached result. Use temp JSONL fixture and temp DB. No `getSessionMetadata()` test needed (not a metadata provider).

### Task 5.3: Runner command test

Test `SessionInspector` renders with mock data, handles null states, tab switching. Test `SessionTable` renders inspect button, triggers callback.

### Task 5.4: CI gates

```bash
bun run test
bun run typecheck
bun run build
```

Fix any failures. Commit.

---

## File Map

| File | Create/Modify | Purpose |
|------|--------------|---------|
| `packages/cli/src/providers/session-analyzer/types.ts` | Create | Shared types |
| `packages/cli/src/providers/session-analyzer/parser.ts` | Create | JSONL parsing (byte-safe) |
| `packages/cli/src/providers/session-analyzer/parser.test.ts` | Create | Parser tests |
| `packages/cli/src/providers/session-analyzer/analyzer.ts` | Create | Context reconstruction |
| `packages/cli/src/providers/session-analyzer/analyzer.test.ts` | Create | Analyzer tests (all edge cases) |
| `packages/cli/src/providers/session-analyzer/db.ts` | Create | SQLite cache |
| `packages/cli/src/providers/session-analyzer/db.test.ts` | Create | DB tests |
| `packages/cli/src/providers/session-analyzer/index.ts` | Create | ExtensionProvider |
| `packages/protocol/src/runner.ts` | Modify | Add `get_session_analysis` command/response types |
| `packages/cli/src/runner/daemon.ts` | Modify | Handle `get_session_analysis` command |
| `packages/server/src/ws/namespaces/runner.ts` | Modify | Route command to runner |
| `packages/server/src/routes/runners.ts` | Modify | Add analysis API route |
| `packages/server/tests/harness/mock-runner.ts` | Modify | Mock `get_session_analysis` |
| `packages/ui/src/components/session-viewer/SessionAnalyzerPanel.tsx` | Create | Live treemap panel |
| `packages/ui/src/components/session-inspector/SessionInspector.tsx` | Create | Inspector page |
| `packages/ui/src/components/session-inspector/types.ts` | Create | UI types |
| `packages/ui/src/components/session-inspector/formatters.ts` | Create | formatTokens, formatCurrency, formatPct |
| `packages/ui/src/components/session-inspector/Treemap.tsx` | Create | SVG treemap |
| `packages/ui/src/components/session-inspector/CostBreakdown.tsx` | Create | Cost chart |
| `packages/ui/src/components/session-inspector/CompactionLog.tsx` | Create | Compaction table |
| `packages/ui/src/components/session-inspector/TurnList.tsx` | Create | Turn table |
| `packages/ui/src/components/SessionViewer.tsx` | Modify | Add panel toggle |
| `packages/ui/src/components/usage-dashboard/SessionTable.tsx` | Modify | Add Inspect button |
| `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx` | Modify | Thread inspect callback |
| `packages/ui/src/components/RunnerDetailPanel.tsx` | Modify | Inspector view state |
