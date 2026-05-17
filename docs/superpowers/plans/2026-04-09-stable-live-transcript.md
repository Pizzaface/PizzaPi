# Stable Live Transcript Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate post-generation message jumping by replacing flat array replacement with a stable live transcript store that preserves item identity and order across streaming, tool updates, snapshots, and reconnects.

**Architecture:** Introduce a normalized transcript store in the UI keyed by stable transcript item IDs, then route live relay events and final snapshots through reconciliation logic instead of wholesale `setMessages(...)` replacement. Promote live Claude tool results into first-class transcript updates keyed by `toolCallId`, and keep grouping as a presentation layer instead of a repair layer.

**Tech Stack:** Bun, TypeScript, React 19, existing PizzaPi remote relay/event pipeline, Bun test.

---

## File Structure

- Create: `packages/ui/src/lib/transcript-store.ts`
  - Pure reducer/helpers for normalized transcript state, ordering, reconciliation, hydration state machine.
- Create: `packages/ui/src/lib/transcript-store.test.ts`
  - Unit tests for live insert/update/reconcile behavior.
- Modify: `packages/ui/src/App.tsx`
  - Replace direct message-array mutation/replacement with transcript-store operations.
- Modify: `packages/ui/src/lib/message-helpers.ts`
  - Add helpers for stable transcript item IDs / message normalization compatibility.
- Modify: `packages/ui/src/lib/message-helpers.test.ts`
  - Test any new identity helpers.
- Modify: `packages/ui/src/components/session-viewer/grouping.ts`
  - Simplify assumptions once the upstream order/identity is stable.
- Modify: `packages/ui/src/components/session-viewer/grouping.test.ts`
  - Lock in non-jumping ordering semantics.
- Modify: `packages/cli/src/extensions/remote/lifecycle-handlers.ts`
  - Stop forwarding Claude live tool results as fake `message_start`/`message_end`; emit a first-class transcript upsert event.
- Modify: `packages/cli/src/extensions/remote-types.ts`
  - Define the new transcript event payload type(s).
- Optional create/modify: protocol/shared typings if needed by the relay event payload shape.

## Chunk 1: Transcript store foundation

### Task 1: Add transcript store types and reducer

**Files:**
- Create: `packages/ui/src/lib/transcript-store.ts`
- Test: `packages/ui/src/lib/transcript-store.test.ts`

- [ ] **Step 1: Write failing reducer tests for stable ordering**

```ts
import { describe, expect, test } from "bun:test";
import {
  createTranscriptState,
  applyLiveMessage,
  reconcileSnapshot,
} from "./transcript-store";

test("reconcileSnapshot preserves existing live item identity while restoring snapshot-relative order", () => {
  let state = createTranscriptState();
  state = applyLiveMessage(state, {
    id: "tool:tc1",
    kind: "toolExecution",
    status: "streaming",
    toolCallId: "tc1",
    toolName: "read",
  });

  state = reconcileSnapshot(state, [
    { id: "user:u1", kind: "message", role: "user" },
    { id: "tool:tc1", kind: "toolExecution", status: "completed", toolCallId: "tc1", toolName: "read" },
  ]);

  expect(state.order).toEqual(["user:u1", "tool:tc1"]);
  expect(state.itemsById.get("tool:tc1")?.status).toBe("completed");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/ui/src/lib/transcript-store.test.ts`
Expected: FAIL because `transcript-store.ts` does not exist yet.

- [ ] **Step 3: Implement minimal transcript store**

Implement a pure module exporting:
- `createTranscriptState()`
- `applyTranscriptItemUpsert()`
- `applyLiveMessage()` compatibility adapter
- `reconcileSnapshot()`
- hydration state helpers for `empty`, `hydrating`, `live`, `reconnecting`

Core rules:
- append ID to `order` only if not already present
- upsert updates existing item in place
- snapshot reconciliation overwrites fields on matching IDs without changing their identity
- snapshot reconciliation restores snapshot-relative order for the full reconciled list while keeping matched items mounted by the same stable IDs
- snapshot-only IDs are inserted according to snapshot order, not blindly appended
- streaming-only items absent from the authoritative snapshot follow an explicit abandonment/removal policy

- [ ] **Step 4: Run reducer tests to verify pass**

Run: `bun test packages/ui/src/lib/transcript-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit foundation**

```bash
git add packages/ui/src/lib/transcript-store.ts packages/ui/src/lib/transcript-store.test.ts
git commit -m "Add transcript store foundation"
```

### Task 2: Cover reconnect and chunked hydration semantics

**Files:**
- Modify: `packages/ui/src/lib/transcript-store.test.ts`

- [ ] **Step 1: Write failing tests for reconnect and hydration state machine**

Add tests for:
- `empty -> hydrating -> live`
- `live -> reconnecting -> hydrating -> live`
- `turn_end` finalizes open assistant/tool partials and clears turn bookkeeping
- buffering live events during chunked hydration then replaying them once hydration completes
- an interleaved chunked sequence: chunk 0 -> buffered live update -> chunk 1 -> final chunk -> replayed live update
- interrupted reconnect / double-hydration does not duplicate items
- removing abandoned provisional items absent from final snapshot

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `bun test packages/ui/src/lib/transcript-store.test.ts`
Expected: FAIL on missing hydration/replay behavior.

- [ ] **Step 3: Implement hydration state helpers and replay support**

Add reducer operations such as:
- `beginHydration(mode)`
- `bufferLiveEventDuringHydration(event)`
- `finalizeHydration(snapshotItems)`
- `replayBufferedEvents()`
- `applyTurnEnd()`

- [ ] **Step 4: Run tests and verify pass**

Run: `bun test packages/ui/src/lib/transcript-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit hydration behavior**

```bash
git add packages/ui/src/lib/transcript-store.test.ts packages/ui/src/lib/transcript-store.ts
git commit -m "Add transcript hydration state machine"
```

## Chunk 2: UI integration

### Task 3: Add stable identity helpers for live items

**Files:**
- Modify: `packages/ui/src/lib/message-helpers.ts`
- Modify: `packages/ui/src/lib/message-helpers.test.ts`

- [ ] **Step 1: Write failing tests for stable transcript IDs**

Add tests for helpers like:
- tool results with `toolCallId` normalize to `tool:<toolCallId>`
- legacy Claude synthetic tool-result messages also map to the same ID
- snapshot/live forms of the same logical tool item produce identical stable IDs

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/ui/src/lib/message-helpers.test.ts`
Expected: FAIL on missing stable transcript ID helpers.

- [ ] **Step 3: Implement helper functions**

Add small pure helpers, e.g.:
- `getStableTranscriptItemId(raw)`
- `toTranscriptItem(raw)`

Do not replace existing `toRelayMessage()` immediately; layer compatibility helpers first.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/ui/src/lib/message-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit identity helpers**

```bash
git add packages/ui/src/lib/message-helpers.ts packages/ui/src/lib/message-helpers.test.ts
git commit -m "Add stable transcript item identity helpers"
```

### Task 4: Route App.tsx through the transcript store

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/lib/transcript-store.ts`
- Test: `packages/ui/src/lib/transcript-store.test.ts`

- [ ] **Step 1: Write failing tests for live-then-final reconciliation**

Add transcript-store tests covering:
- assistant `message_start` / `message_update` / `message_end` followed by `agent_end`
- existing logical items retain stable IDs and do not remount as different items
- resulting transcript order is correct after reconciliation
- only fields finalize in place
- legacy synthetic Claude tool-result `message_start` / `message_end` events normalize onto `tool:<toolCallId>`

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `bun test packages/ui/src/lib/transcript-store.test.ts`
Expected: FAIL on missing live/final reconciliation invariants.

- [ ] **Step 3: Refactor `App.tsx` to derive `messages` from transcript state**

Implement minimal integration:
- keep React state for rendered messages, but derive it from transcript store snapshots
- replace direct `setMessages(normalizedMessages)` on `session_active` / `agent_end` with transcript-store reconciliation
- route `message_start`, `message_update`, `message_end`, `turn_end`, and `tool_execution_*` through transcript-store operations where possible
- route existing synthetic Claude `toolResult` message events through stable transcript identity helpers so they already collapse onto `tool:<toolCallId>` before the new relay event ships
- preserve existing MCP/auth/status handling outside the transcript path

- [ ] **Step 4: Run UI-focused tests, build, and typecheck**

Run:
```bash
bun test packages/ui/src/lib/message-helpers.test.ts packages/ui/src/components/session-viewer/grouping.test.ts packages/ui/src/lib/transcript-store.test.ts
bun x tsc -p packages/ui/tsconfig.json --noEmit
bun run build
```
Expected: PASS.

- [ ] **Step 4.5: Do a manual smoke check**

Checklist:
- open a live session in the browser
- verify no crash on load
- verify a streamed assistant reply appears while generating
- verify the transcript does not visibly jump when generation completes

- [ ] **Step 5: Commit UI integration**

```bash
git add packages/ui/src/App.tsx packages/ui/src/lib/transcript-store.ts packages/ui/src/lib/transcript-store.test.ts packages/ui/src/lib/message-helpers.ts packages/ui/src/lib/message-helpers.test.ts
git commit -m "Reconcile live transcript updates in UI"
```

## Chunk 3: Remote protocol cleanup for Claude tool results

### Task 5: Add first-class transcript upsert event for live tool results

**Files:**
- Modify: `packages/cli/src/extensions/remote-types.ts`
- Modify: `packages/cli/src/extensions/remote/lifecycle-handlers.ts`
- Modify: any UI relay event handling types if needed

- [ ] **Step 1: Write failing tests or fixture coverage for the new event shape**

If no direct remote tests exist, add a pure helper test around payload normalization in UI/CLI. Minimum contract:
- live Claude tool result is emitted as a transcript item upsert keyed by `tool:<toolCallId>`
- no fake `message_start` / `message_end` pair is emitted for that result

- [ ] **Step 2: Run targeted tests to verify failure**

Run the narrowest relevant test command for the added test file(s).
Expected: FAIL on missing event shape.

- [ ] **Step 3: Implement the new relay event path**

In `lifecycle-handlers.ts`:
- replace the synthetic `message_start` / `message_end` forwarding for `claude-code:tool_result`
- emit a dedicated event such as `transcript_item_upsert`

In `remote-types.ts`:
- define the payload contract clearly enough for UI handling

- [ ] **Step 4: Run targeted tests and CLI typecheck**

Run:
```bash
bun test packages/cli/src/extensions/claude-code-provider
bun x tsc -p packages/cli/tsconfig.json --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit remote protocol cleanup**

```bash
git add packages/cli/src/extensions/remote/lifecycle-handlers.ts packages/cli/src/extensions/remote-types.ts
git commit -m "Send live tool results as transcript upserts"
```

### Task 6: Consume transcript upsert events in the viewer

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/lib/transcript-store.ts`
- Test: `packages/ui/src/lib/transcript-store.test.ts`

- [ ] **Step 1: Write failing tests for transcript upsert consumption**

Add tests verifying:
- tool result upsert before tool call still produces one stable `tool:<toolCallId>` item
- later snapshot reconciliation finalizes the same item

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/ui/src/lib/transcript-store.test.ts packages/ui/src/components/session-viewer/grouping.test.ts`
Expected: FAIL on unhandled transcript upsert event.

- [ ] **Step 3: Implement event handling in `App.tsx`**

Handle the new relay event by:
- converting the payload into a transcript-store item
- updating the normalized store in place
- deriving rendered messages from store output

- [ ] **Step 4: Run UI tests and typecheck**

Run:
```bash
bun test packages/ui/src/lib/transcript-store.test.ts packages/ui/src/components/session-viewer/grouping.test.ts packages/ui/src/lib/message-helpers.test.ts
bun x tsc -p packages/ui/tsconfig.json --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit viewer transcript upsert handling**

```bash
git add packages/ui/src/App.tsx packages/ui/src/lib/transcript-store.ts packages/ui/src/lib/transcript-store.test.ts packages/ui/src/components/session-viewer/grouping.test.ts
git commit -m "Handle transcript upserts in viewer"
```

## Chunk 4: Presentation cleanup and final verification

### Task 7: Simplify grouping to be presentation-only

**Files:**
- Modify: `packages/ui/src/components/session-viewer/grouping.ts`
- Modify: `packages/ui/src/components/session-viewer/grouping.test.ts`

- [ ] **Step 1: Add or tighten tests for the stabilized upstream model**

Add tests ensuring:
- grouping no longer needs to repair duplicate live/final items
- tool execution ordering remains stable with pre-finalized items
- reconnect/chunked hydration cases do not create duplicate grouped cards

- [ ] **Step 2: Identify specific repair heuristics now made redundant**

List the exact branches/helpers to remove, based on transcript-store guarantees, before editing the file.

- [ ] **Step 3: Remove redundant repair heuristics carefully**

Prefer deleting only logic made unnecessary by the new transcript-store invariants. Keep presentation behavior intact.

- [ ] **Step 4: Run grouping tests and UI typecheck**

Run:
```bash
bun test packages/ui/src/components/session-viewer/grouping.test.ts packages/ui/src/lib/transcript-store.test.ts packages/ui/src/lib/message-helpers.test.ts
bun x tsc -p packages/ui/tsconfig.json --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit grouping cleanup**

```bash
git add packages/ui/src/components/session-viewer/grouping.ts packages/ui/src/components/session-viewer/grouping.test.ts
git commit -m "Simplify transcript grouping after store migration"
```

### Task 8: Run end-to-end verification and polish

**Files:**
- Modify: any touched files needed for final fixes

- [ ] **Step 1: Run full targeted verification**

Run:
```bash
bun test packages/ui/src/lib/transcript-store.test.ts packages/ui/src/lib/message-helpers.test.ts packages/ui/src/components/session-viewer/grouping.test.ts
bun test packages/cli/src/extensions/claude-code-provider
bun x tsc -p packages/ui/tsconfig.json --noEmit
bun x tsc -p packages/cli/tsconfig.json --noEmit
bun run build
```
Expected: PASS.

- [ ] **Step 2: Manually inspect diff for architectural drift**

Run:
```bash
git diff --stat origin/feat/claude-code-provider...HEAD
git diff -- packages/ui/src/App.tsx packages/ui/src/lib/transcript-store.ts packages/cli/src/extensions/remote/lifecycle-handlers.ts
```
Expected: Changes are confined to transcript-state and relay-event handling, not unrelated UI behavior.

- [ ] **Step 2.5: Update repository test coverage docs if needed**

If `AGENTS.md` or other repo docs track test file counts/coverage areas, update them for the new transcript-store tests.

- [ ] **Step 3: Commit any final adjustments**

```bash
git add <final touched files>
git commit -m "Polish stable live transcript flow"
```

- [ ] **Step 4: Push branch**

```bash
git pull --rebase
git push
```
Expected: branch is up to date on origin.
