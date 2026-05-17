# Session Context & Caching Insights — Design Spec

**Date:** 2026-05-16
**Status:** Draft (reviewed, P1 fixes applied)

## Overview

Add a SpaceSniffer-style context usage visualization to PizzaPi, showing how each session's context window is consumed across turns. Provide cache hit rate metrics and cost breakdowns — both as a live collapsible panel in the SessionViewer and as a drill-down page from the Usage Dashboard.

Users want to answer: "How much is caching saving me?" and "What's eating my context window?"

---

## Architecture

A single **ExtensionProvider** (`session-analyzer`) on the runner daemon handles all data collection and computation. Data delivery uses two existing infrastructure paths:

1. **`sessionMetadataCards`** — Registers an API endpoint that the Session Inspector page (a first-party UI route) fetches structured `SessionAnalysis` data from.
2. **`panel`** (iframe) — For the live in-session panel in the SessionViewer. The iframe self-polls provider API routes (see Transport section below).

No new CLI commands or server API routes needed. The provider uses its built-in capabilities.

### Capabilities Used

| Capability | Purpose |
|-----------|---------|
| `lifecycle` | `onTurnEnd` → parse JSONL incrementally, compute context blocks, detect compaction boundaries, write to provider SQLite |
| `metadata` | `getSessionMetadata(sessionId)` → return `SessionAnalysis` for the session inspector page |
| `ui-panel` | Panel iframe rendering the SpaceSniffer treemap + cache sparkline (collapsible, in SessionViewer header area) |
| `context` | `onBeforeAgentStart` → inject cache efficiency hint into system prompt |

---

## Data Model

### Source: Pi JSONL Session Files

Pi sessions are stored as JSONL with a tree structure (`id`/`parentId`). Key entry types used:

- **`message`** (role: `assistant`): Contains `usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` per turn
- **`message`** (role: `user`, `toolResult`): Present in context but don't carry usage data
- **`compaction`**: Has `summary`, `firstKeptEntryId`, `tokensBefore` — marks where older context was replaced by a summary
- **`branch_summary`**: Injected when `/tree` navigation leaves a branch; consumes real context
- **`custom_message`**: Extension-injected messages that appear in context
- **`model_change`**: Records model switches

### Context Reconstruction (Heuristic)

Context composition is **approximated** by walking the active branch leaf→root, applying the same semantics as pi's `buildSessionContext()`. Exact per-block token attribution is not possible from JSONL alone — `usage.input` is the full prompt size for that request, not the incremental contribution. The approach produces **estimated blocks for visualization**, not accounting-grade numbers.

1. Walk from leaf to root collecting entries
2. When a `CompactionEntry` is encountered, skip messages between it and `firstKeptEntryId` (they've been replaced by the summary)
3. When a `BranchSummaryEntry` is encountered, include it as a block
4. When a `CustomMessageEntry` is encountered, include it as a block
5. Approximate token contributions:
   - **Assistant messages**: Use the assistant's own `usage.input` as the snapshot of context size at that point. A turn's block size is the delta from the previous assistant's `usage.input` (or from 0 for the first turn). Deltas are clamped to ≥ 0 for block rendering — negative deltas (which occur after compaction or model changes) are rendered as **separator bars** in the treemap rather than negative-width blocks. The raw delta is preserved in `block.rawTokenDelta` for the sparkline but `block.tokens` is never negative.
   - **Compaction summary**: Estimated from summary text length ÷ ~3.5 chars/token (rough English estimate). Provider-aware tokenization is not available.
   - **Branch summary / custom message**: Estimated from content text length.
   - **System prompt / base overhead**: The remainder after accounting for all tracked blocks. May be inaccurate.
6. `usage.cacheRead`/`usage.cacheWrite` are direct from assistant messages

### Types

```typescript
interface Usage {
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
}

interface ContextBlock {
  turnIndex: number;
  entryId: string;
  /** A block represents a turn's total context contribution (user + assistant + tool results),
   *  a special entry (compaction/branch summary, custom message), or the system/base overhead.
   *  Per-role token splits within a turn are estimated heuristically in subBlocks. */
  role: "turn" | "system" | "compaction_summary" | "branch_summary" | "custom_message"
       | "separator";  // compaction or model-reset boundary (rendered as bar, not block)
  /** Estimated context contribution for this block. Always ≥ 0 for rendering.
   *  Negative raw deltas are captured in rawTokenDelta and rendered as separators. */
  tokens: number;
  /** Raw delta from previous assistant input (may be negative). Used for sparkline only. */
  rawTokenDelta: number;
  usage?: Usage;               // from the assistant message in this turn
  model?: { provider: string; id: string };  // model active at this turn
  /** Heuristic breakdown of the turn block into per-role sub-components.
   *  Estimated from content length ratios. Null for non-turn blocks. */
  subBlocks?: Array<{
    role: "user" | "assistant" | "tool_result";
    tokens: number;  // estimated from content length
  }>;
}

interface CompactionBoundary {
  entryId: string;
  tokensBeforeCompaction: number;   // pre-compaction context size (from CompactionEntry.tokensBefore)
  estimatedSummaryTokens: number;   // heuristic estimate of summary token cost
  estimatedTokensAfter: number | null;  // estimated post-compaction context (null if unknown)
  estimatedTokensFreed: number | null;  // before - after (null if after is unknown)
  firstKeptId: string;
  timestamp: string;
}

interface SessionAnalysis {
  sessionId: string;
  /** Model at the current leaf (for display purposes) */
  activeModel: { provider: string; id: string; contextWindow?: number } | null;
  /** All models used, with per-model stats */
  modelsUsed: Array<{
    provider: string;
    id: string;
    contextWindow?: number;
    turns: number;
    totalCost: number;
    cacheHitRate: number;
  }>;
  blocks: ContextBlock[];
  compactions: CompactionBoundary[];
  summary: {
    totalTokens: number;
    totalCost: number;
    /** cacheRead / (input + cacheRead) — per Anthropic caching semantics */
    cacheHitRate: number;
    /** 
     * Estimated $ saved by caching. Computed per-model as:
     *   Σ (cacheReadTokens * (uncachedInputPricePerToken - cacheReadPricePerToken))
     * Requires both cost data and per-model pricing. Falls back to null if any turn is
     * missing cost or if the model's pricing is unavailable.
     */
    estimatedCacheSavings: number | null;
    compactionCount: number;
    /** Sum of estimatedTokensFreed across all compactions (null if any are unknown) */
    tokensFreedByCompaction: number | null;
    /** Highest observed usage.input value (context peak, heuristic) */
    peakContextUsage: number | null;
    /** Mean % of context window used (null if contextWindow is unknown) */
    contextUtilization: number | null;
  };
}
```

---

## Provider Design

Location: `~/.pizzapi/providers/session-analyzer/`

```
session-analyzer/
  index.ts          # ExtensionProvider
  panel/
    index.html      # SpaceSniffer treemap iframe (live panel)
  db.ts             # SQLite operations
  analyzer.ts       # JSONL parsing + context reconstruction
```

### Transport: How Data Gets to the UI

Two paths, both using existing PizzaPi infrastructure:

#### Live Panel (iframe)

The provider declares a `panel` capability. The panel is a self-contained HTML file served by the daemon's built-in panel host at a path like `/provider/session-analyzer/panel/`. The iframe polls the **metadata API endpoint** (served by the daemon, backed by `getSessionMetadata()`):

| Route | Returns |
|-------|---------|
| `./api/session-analysis?sessionId=X` | Full `SessionAnalysis` |

The daemon already serves provider panel assets and proxies API calls through its tunnel infrastructure. The panel polls this single endpoint on a 10–15s interval (reduced from 3–5s to avoid unnecessary churn). For active live sessions, the panel also listens for a custom `session-analyzer:updated` relay event — the provider fires this as a push notification after major state changes (compaction, turn end), and the panel skips the next poll cycle when it receives one.

#### Session Inspector Page (drill-down from Usage Dashboard)

The provider registers `sessionMetadataCards` to expose a metadata endpoint:

```typescript
get sessionMetadataCards() {
  return [{
    id: "session-analyzer-inspector",
    label: "Context & Cache Analysis",
    source: { type: "api", endpoint: "./api/session-analysis" },
  }];
}
```

This is NOT an HTML card — it's a structured data endpoint. The inspector page (a new first-party UI route at `/session-inspector/:sessionId`) calls this endpoint to fetch `SessionAnalysis` and renders the full-page treemap itself using PizzaPi's React components. This is a one-time fetch, not polling. The provider card registration exists solely to expose the data; the UI route owns the rendering.

### Provider Capability: Firing Push Updates

The provider fires a relay trigger after major state changes to push updates to the live panel (instead of relying solely on polling):

```typescript
async onTurnEnd(event, ctx) {
  // ... compute new blocks ...
  ctx.fireTrigger(ctx.sessionId, "session-analyzer:updated", {
    sessionId: ctx.sessionId,
    timestamp: Date.now(),
  });
}
```

The panel iframe subscribes to this trigger type and skips a poll cycle when received. If trigger delivery fails (no relay), the panel falls back to polling.

### Lifecycle Hooks

**`onTurnEnd(event, ctx)`** — Incrementally read the session JSONL from last processed offset, parse new entries, detect compaction and branch summary boundaries, recompute blocks and summary, write to provider SQLite cache. Fire `session-analyzer:updated` trigger.

**Note on compaction detection**: Compaction entries are appended to JSONL during `/compact` or auto-compaction. Detection uses two paths:
1. **`onTurnEnd`**: Catches compactions that occur within a turn boundary.
2. **Poll-on-access freshness**: The panel polls `getSessionMetadata()` every 10–15s, and `getSessionMetadata()` revalidates against the JSONL file mtime/size before returning data (see Metadata section). This catches out-of-band compactions without a persistent file watcher — the next poll after a compaction triggers a catch-up scan. No background timer needed.

For sessions ending immediately after a compaction with no further turns, `onSessionClose` handles the final scan.

**`onSessionClose(event, ctx)`** — Final scan of remaining JSONL entries. Return label for UI feedback.

### Metadata

**`getSessionMetadata(sessionId, ctx)`** — Revalidate against JSONL file (check mtime/size vs last processed state) before returning cached data. If the file has changed since last scan, run a catch-up incremental parse, update the cache, then return the freshest `SessionAnalysis`. This ensures the inspector page always returns current data even if the panel was collapsed or the daemon restarted.

### Context Injection

**`onBeforeAgentStart(event, ctx)`** — If cache hit rate > 10% and session has meaningful usage:
> "Cache efficiency: 73% hit rate (est. savings: $1.42 this session)"

Inject only when `estimatedCacheSavings` is non-null and > 0.

---

## UI Components

### 1. Live Panel — Collapsible, in SessionViewer

**Position**: Toggle button next to existing `ContextDonut` in the session header. Panel drops down below the header, ~280px tall.

**Collapsed state**: Single line showing cache hit rate sparkline + key metrics.
```
▁▂▃▅▇█  Cache: 73% hit  ·  Est. saved: $1.42  ·  Peak: 68%  ·  3 compactions
```

**Expanded state**: SpaceSniffer treemap.

- Proportional rectangles sized by `ContextBlock.tokens`
- Color-coded by role: turn=blue, system=gray, compaction_summary=orange, branch_summary=purple, custom_message=teal, separator=thin horizontal bar
- Green tint overlay proportional to `cacheRead / input` ratio (turn blocks only)
- Turn blocks can optionally show nested sub-segments (user/assistant/tool) sized from content-length heuristics — shown as stacked bars within the turn rectangle
- Compaction boundary: thin horizontal separator bar showing `42k → ~2k` (tokensBeforeCompaction → estimatedTokensAfter)
- Hover tooltip: turn #, entryId, token count, cache read/write, cost (if available)
- Click: locks detail panel for that block
- Below treemap: context growth sparkline with compaction markers
- "Approximate" label in UI to set user expectations about heuristic data

### 2. Session Inspector Page — Full-Page Drill-Down

**Route**: `/session-inspector/:sessionId`
**Entry point**: Click any session row in the Usage Dashboard's `SessionTable`

**Layout**:
- **Header**: Session name, active model, duration, total cost, cache hit rate hero number, models used count
- **Left 60%**: Full-size interactive treemap with zoom/pan. Clicking a block scrolls the detail panels on the right
- **Right 40%**: Tabbed panels:
  1. **Cost Breakdown** — pie chart: input cost vs cache read cost vs output cost (null-safe: "Cost data unavailable" if costs missing)
  2. **Compaction Log** — timeline of events: when, tokens before, estimated freed, summary tokens
  3. **Turn List** — sortable table of all turns with token/cache/cost columns, model info per turn
  4. **Model Breakdown** — per-model stats table (from `modelsUsed[]`)

---

## Data Flow

```
JSONL session file
        │
        ▼
┌─ session-analyzer provider ─────────────────────────────┐
│                                                          │
│  onTurnEnd:                                              │
│    read JSONL (incremental, from last offset)             │
│    → parse new entries (message, compaction,              │
│      branch_summary, custom_message, model_change)       │
│    → walk leaf→root, apply buildSessionContext logic     │
│    → compute blocks[], compactions[], modelsUsed[],      │
│      summary{} (heuristic)                               │
│    → write to SQLite cache                                │
│    → fire "session-analyzer:updated" trigger              │
│                                                          │
│  getSessionMetadata(sessionId):                           │
│    → query SQLite → return SessionAnalysis                │
│                                                          │
│  Live panel (iframe):                                     │
│    → polls ./api/session-analysis (10–15s interval)       │
│    → listens for "session-analyzer:updated" push          │
│    → renders treemap + sparkline                          │
│                                                          │
│  Session Inspector page:                                  │
│    → one-time fetch getSessionMetadata(sessionId)         │
│    → renders full-page treemap + details                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
        │
        ▼
  relay → UI (live panel + session inspector page)
```

---

## Edge Cases

The analyzer must handle these pi session patterns:

| Case | Handling |
|------|----------|
| **Split-turn compaction** | A compaction mid-turn: `firstKeptEntryId` may point to an assistant message within the same turn. The analyzer only shows the kept suffix in `blocks[]` (live context). Compaction is represented as a `CompactionBoundary` entry, not as an `isCompacted` flag on blocks. |
| **Repeated compactions** | Multiple `CompactionEntry`s on the path. Each applies its own `firstKeptEntryId` skip range. The analyzer processes them in leaf→root order. |
| **Branch switch with `branch_summary`** | `BranchSummaryEntry` appears on the current path. Included as a `ContextBlock` with role `branch_summary`. |
| **Session resume after restart** | Provider re-reads the full JSONL on the first `onTurnEnd` after session reload. Uses `getSessionMetadata()` to detect previously cached data and revalidate. |
| **Truncated/malformed JSONL** | Lines that fail to parse: stop processing at that point. Advance the durable byte offset only past fully parsed lines ending in `\n`. If the final line in the file is incomplete (no trailing `\n`, or partial write), retain its starting byte offset and retry from there on the next scan. Historical malformed lines (not at the tail) are skipped once — their offset is advanced past to avoid blocking future scans, but they count as data loss. |
| **No assistant usage yet** | New session with no responses: `blocks` is empty, `summary` has null metrics. `estimatedCacheSavings` is null. Panel shows "Waiting for first response…" |
| **Missing cost data** | Some providers/models may not include `usage.cost`. `estimatedCacheSavings` is null, cost pie chart shows "unavailable". |
| **Unknown context window** | Some custom models may not report `contextWindow`. `contextUtilization` is null, peak usage is absolute tokens only. |
| **Mixed models** | `model_change` entries are tracked. `modelsUsed[]` has per-model stats. `ContextBlock.model` identifies the active model per block. Visualization can filter by model. |

---

## Implementation Order

1. **Analyzer library** (`analyzer.ts`): Pure functions to parse JSONL, reconstruct context blocks (heuristic), detect compaction and branch_summary boundaries, compute cache hit rate and per-model stats. Unit tests with edge case fixtures.
2. **Provider** (`index.ts`): ExtensionProvider wiring — lifecycle hooks, metadata, context injection, trigger firing, SQLite caching.
3. **Panel iframe** (`panel/index.html`): SpaceSniffer treemap rendering, sparkline, API polling + trigger listener, "Approximate" disclaimer.
4. **Live panel integration**: Toggle button + collapsible panel in SessionViewer header area.
5. **Session Inspector page**: New route `/session-inspector/:sessionId`, full-page layout, linked from Usage Dashboard SessionTable.
6. **Tests**: Analyzer unit tests (JSONL parsing, context reconstruction, split-turn, repeated compactions, branch summaries, malformed input, missing costs), provider integration tests, panel visual tests.

---

## Key Decisions

- **Runner-side, not server-side**: The provider runs on the runner daemon and has direct access to JSONL files. No server-side DB changes needed.
- **Reconstruct from JSONL, don't add new events**: Uses existing `CompactionEntry`, `BranchSummaryEntry`, and `Usage` data already in JSONL. No changes to pi's core logging.
- **ExtensionProvider, not ServiceHandler**: Needs lifecycle hooks (`onTurnEnd`) for incremental parsing and `getSessionMetadata()` for historical access.
- **Heuristic, not accounting-grade**: Token block sizes are estimates. The UI labels them as "Approximate" to set correct expectations. The primary value is the visual relative proportions and cache/cost trends, not precise per-block accounting.
- **Push + poll, not pure poll**: Push triggers reduce latency for active sessions; polling covers historical views and fallback.
- **`sessionMetadataCards` for inspector**: Uses existing provider metadata infrastructure instead of custom HTTP routes, avoiding the port-announcement gap in ExtensionProvider.
