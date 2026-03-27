# Tonight's Menu — Night Shift 20260323-190417 (v2, post-Opus refinement)

**Goal:** Refactor the runner ↔ server ↔ UI architecture for speed, simplicity, and beautiful payload management
**Strategy:** Phase 1 from the design spec — decompose relay.ts into clean modules. Plus the heartbeat quick-win and protocol types audit.
**Design Spec:** `design-spec.md` (full architectural blueprint for Phases 1-4)

## Key Insight from Opus
> `agent_end` already carries full state — the event stream is already a delta stream. The problem is reconnection, not the event format. `sessionEventQueues` exist only for chunk ordering — removable after delta architecture.

| # | Dish | Cook Type | Complexity | Dependencies | Status |
|---|------|-----------|------------|--------------|--------|
| 001 | Extract thinking-tracker.ts | sonnet | S | none | queued |
| 002 | Extract push-tracker.ts | sonnet | S | none | queued |
| 003 | Extract ack-tracker.ts | sonnet | XS | none | queued |
| 004 | Extract messaging.ts (session_message, triggers) | sonnet | M | none | queued |
| 005 | Extract child-lifecycle.ts (cleanup, delink) | sonnet | M | none | queued |
| 006 | Extract session-lifecycle.ts (register, end, disconnect) | sonnet | M | none | queued |
| 007 | Create relay/index.ts wiring + convert relay.ts | sonnet | S | 001-006 | queued |
| 008 | Unit tests for thinking-tracker + push-tracker | sonnet | S | 001, 002 | queued |
| 009 | Heartbeat quick-win (skip full SA for metadata-only) | sonnet | M | none | queued |
| 010 | Protocol types audit & completion | sonnet | M | none | queued |
| 011 | Design spec delivered ✅ | opus | L | none | served |

## Fire Order

### Wave 1 (parallel, no dependencies) — 7 dishes
- **001-006** — Relay module extractions (all independent — each extracts from relay.ts)
- **009** — Heartbeat optimization (independent of relay decomposition)
- **010** — Protocol types audit (independent)

### Wave 2 (after 001-006) — 2 dishes
- **007** — Wire relay/index.ts (needs all extractions done)
- **008** — Unit tests (needs 001, 002)

## Architecture Impact

Tonight covers **Phase 1** from the design spec:
- relay.ts (1,183 lines) → 8 focused modules (~80-200 lines each)
- Heartbeat optimization → 80% bandwidth reduction for idle sessions
- Protocol types → compile-time safety for event pipeline

Future shifts from the spec:
- **Phase 2:** Delta event architecture + eliminate chunked delivery (1-2 shifts)
- **Phase 3:** Persistence cleanup — Redis Streams, remove lastState (1 shift)
- **Phase 4:** UI decomposition — App.tsx hook extraction (2+ shifts)

## Cook Notes

- All dishes use `claude-sonnet-4-6` (anthropic)
- Critics use `gemini-3.1-pro-preview` (google) — OpenAI at 85% 7-day
- Extractions (001-006) are purely structural — zero behavior changes
- Each extraction can be a separate branch and PR
