# Stable Live Transcript Design

## Problem

The session viewer currently renders a conversation from multiple competing sources of truth:

1. live stream events (`message_start`, `message_update`, `message_end`, `turn_end`)
2. live tool execution events (`tool_execution_*`)
3. synthetic Claude tool-result injections (`claude-code:tool_result` forwarded as `message_start`/`message_end`)
4. snapshot replacement events (`session_active`, `agent_end`)
5. chunked hydration assembly (`session_messages_chunk`)

This works well enough for eventual correctness, but it causes visible message jumping after generation completes. The core failure mode is not just ordering bugs inside the grouping layer. The deeper issue is architectural: the UI is allowed to render provisional items from one event stream and then replace the whole transcript from another stream after the turn finishes.

## Root Cause

The current design mixes two incompatible models:

- **append/update log model** for live streaming
- **authoritative snapshot replacement model** for completion/hydration

Important evidence from the current implementation:

- `packages/ui/src/App.tsx` uses `upsertMessage()` / `upsertMessageDebounced()` to append and mutate live messages in place.
- The same file later performs wholesale replacements on `session_active` and `agent_end` via `setMessages(...)` using normalized snapshots.
- `packages/ui/src/components/session-viewer/grouping.ts` contains increasingly complex reconciliation logic because message order and identity are not stable enough upstream.
- Claude tool results are currently forwarded as synthetic message events from `packages/cli/src/extensions/remote/lifecycle-handlers.ts`, which means the viewer sees them as normal transcript messages before the final transcript is re-derived from session state.

This means a viewer can see:

1. a live provisional assistant/tool item inserted into the list
2. a later finalized assistant/tool item with a different shape
3. a full transcript replacement on `agent_end`

Even if the semantic content is correct, the rendered list reorders, remounts, and regroups items, which appears as jumping.

## Goal

Preserve live updates while making transcript rendering stable:

- once a logical message/tool card is inserted, it should keep its position
- completion should update existing items in place, not replace or reorder them
- hydration/reconnect should still work for viewers joining late
- Claude-specific behavior should fit a general remote transcript model, not a one-off special case

## Non-Goals

- removing grouping/presentation logic entirely
- redesigning the entire protocol in one step
- changing persisted session transcript semantics

## Constraints

- The current remote protocol already supports message lifecycle events and full snapshots.
- Existing viewers need hydration on connect and reconnect.
- The CLI/provider stack may not always have final stable message IDs for partial assistant content, so the design must allow synthetic client-visible IDs as long as they are stable across finalization.
- Tool calls and tool results are logically tied by `toolCallId`; that should remain the primary identity for tool execution items.

## Design Principles

1. **Single logical item, multiple updates**  
   A live-rendered thing must have one stable identity from first appearance through finalization.

2. **Snapshots hydrate missing state, not replace active state**  
   `session_active` / `agent_end` should reconcile into existing items instead of wholesale replacing the message list for an already-live session.

3. **Presentation should not repair protocol contradictions**  
   `grouping.ts` should format a stable sequence, not guess intended ordering from contradictory inputs.

4. **Tool execution is first-class transcript state**  
   Tool results should not be smuggled in as ad-hoc assistant-like messages with fallback identity rules.

## Options Considered

### Option A — Keep patching UI reconciliation

Add more buffering and grouping heuristics so the existing streams appear stable.

**Pros**
- Smallest immediate diff
- No protocol changes

**Cons**
- Continues layering heuristics over contradictory event sources
- High risk of future regressions for reconnects, chunked hydration, and other providers
- Keeps `grouping.ts` as a repair layer rather than presentation

### Option B — Stable synthetic live message protocol

Keep current relay structure, but assign stable IDs to synthetic live tool results and final assistant/tool items so the UI always upserts by durable identity.

**Pros**
- Solves much of the visible jumping
- Moderate scope
- Good migration path

**Cons**
- Still partially synthetic
- Leaves ambiguity between “live stream items” and “session transcript items”

### Option C — Stable transcript event model (recommended)

Treat relay streaming and finalization as updates to one canonical live transcript model. Introduce first-class transcript item identity and reconciliation rules so live events, tool events, and snapshots all operate on the same logical items.

**Pros**
- Cleanest long-term model
- Reduces UI heuristic complexity
- Makes Claude tool results fit naturally into the same transcript system
- Avoids post-generation jumps by design

**Cons**
- Requires protocol/UI/relay work
- More invasive than a pure UI patch

## Recommended Architecture

Adopt **Option C**, implemented incrementally through the following model.

### Hydration state machine

The viewer should stop using an implicit cold/warm boolean and instead use an explicit lifecycle:

- `empty` — no transcript loaded yet
- `hydrating` — initial `session_active` or chunked snapshot load in progress
- `live` — hydration completed and live events may update the store
- `reconnecting` — viewer lost connection after previously being live; existing store is retained until the next snapshot reconciles it

Rules:

- `empty -> hydrating` on initial connect/open session
- `hydrating -> live` when a non-chunked snapshot is applied or the final chunk is assembled
- `live -> reconnecting` on disconnect/reconnect path when the current session already has rendered transcript items
- `reconnecting -> hydrating` when the replacement snapshot stream begins
- `hydrating -> live` again after reconciliation completes

Snapshot handling must be keyed off this state machine, not a single `awaitingSnapshot` check.

### 1. Introduce stable transcript item identity

Every live-rendered transcript item should have a stable key that survives finalization.

Proposed identity rules:

- **Tool execution item**: `tool:<toolCallId>`
- **Assistant message item**: a stable assistant stream ID created at first appearance by the relay/provider layer and reused by `message_start`, `message_update`, and `message_end` for that logical assistant turn
- **User/system/toolResult items from persisted transcript**: existing persisted IDs where available, otherwise normalized deterministic IDs during snapshot import

For Claude tool results specifically, the logical item is not “a random message event”. It is the result half of a tool execution item keyed by `toolCallId`.

This is a protocol requirement, not a UI best effort. The relay/provider path must provide the stable assistant/item ID before the viewer can guarantee no remounting during finalization.

### 2. Split transcript state from hydration state

The viewer should maintain a normalized store, not just a flat array that gets replaced.

Suggested structure:

- `itemsById: Map<string, TranscriptItem>`
- `order: string[]`
- `hydrationState` for snapshot/chunk loading
- `pendingPartialState` keyed by item ID
- `turnState` for current live turn bookkeeping (open assistant item, in-flight tool items, pending finalization)

Rendering derives the visible array from `order.map(id => itemsById.get(id))`.

This allows:
- insert once
- update fields in place
- preserve order unless a truly new item is introduced
- keep `order` append-only with dedup semantics: append an ID only if it is not already present

Garbage collection:

- `pendingPartialState` entries are removed when their item reaches terminal status
- abandoned provisional items may be pruned during snapshot reconciliation if they were never finalized and are absent from the authoritative snapshot

### 3. Reconcile snapshots instead of replacing messages

For an already-active or reconnecting session:

- `session_active` and `agent_end` should be treated as reconciliation inputs
- existing item IDs keep their position
- snapshot-only items are appended only when they were never seen live
- finalized fields overwrite provisional fields on matching items
- provisional-only items absent from the authoritative snapshot are marked abandoned or removed according to explicit policy, rather than left hanging indefinitely

Reconciliation policy:

- **cold hydration (`empty -> hydrating`)**: snapshot initializes the store
- **warm completion (`live`)**: snapshot reconciles into the existing store
- **reconnect hydration (`reconnecting -> hydrating`)**: snapshot reconciles against retained items, preferring authoritative server ordering only for brand-new IDs
- **chunked hydration**: live events are buffered until chunk assembly finishes, then replayed into the reconciled store in sequence

This avoids the current behavior where live content is rendered and then replaced by a wholesale array swap.

### 4. Make tool execution a first-class transcript primitive

Instead of forwarding Claude live tool results as synthetic `message_start` / `message_end`, the relay should expose a first-class event for transcript tool-result updates.

Recommended shape:

```ts
{
  type: "transcript_item_upsert",
  item: {
    kind: "toolExecution",
    id: "tool:<toolCallId>",
    toolCallId: "...",
    toolName: "read",
    toolInput: {...},
    content: ...,
    isError: false,
    status: "streaming" | "completed",
    timestamp?: number,
  }
}
```

Semantics:

- an item is appended to `order` only if its `id` is not already present
- otherwise the existing item is updated in place
- during migration, any synthetic Claude `toolResult` message carrying `toolCallId` must be normalized to `tool:<toolCallId>` before store insertion so Phase 2 and Phase 3 do not create duplicate logical items

This avoids pretending a tool result is a standalone assistant transcript message.

### 5. Reduce grouping responsibility

After the normalized transcript store exists:

- `grouping.ts` should mainly format assistant content around tool execution items
- it should no longer need to repair out-of-order tool results or deduplicate contradictory snapshots from multiple upstream sources

Some grouping logic will remain for presentation, but ordering correctness should come from the normalized transcript store.

## Data Flow

### Current

provider stream -> relay events -> UI upserts flat message array  
provider/session end -> final transcript snapshot -> UI replaces array  
result: remount/reorder/jump

### Proposed

provider stream -> normalized transcript updates -> UI store upserts by stable ID  
session end snapshot -> reconcile by stable ID into same store  
result: items finalize in place without jumping

## Migration Plan

### Phase 1 — Viewer transcript store

Refactor the UI to maintain a normalized transcript store behind the existing rendering surface.

- Add a small transcript reducer/store module in `packages/ui/src/lib/`
- Convert current event handlers from direct `setMessages` replacement to store operations
- Keep the existing `RelayMessage` render contract initially to limit UI churn

### Phase 2 — Reconcile snapshots in warm sessions

Change `session_active`, `agent_end`, and chunk-finalization handling:

- cold load: initialize store from snapshot
- warm/live load: reconcile snapshot into current store
- reconnect load: reconcile authoritative snapshot into retained store
- preserve existing item order for matching IDs
- buffer live events during chunked hydration and replay them after final chunk assembly
- normalize synthetic Claude `toolResult` messages with `toolCallId` onto the future `tool:<toolCallId>` identity scheme immediately, even before the dedicated protocol event exists

### Phase 3 — First-class live tool-result event

Update remote protocol/relay handling so Claude live tool results are not forwarded as fake `message_start`/`message_end` pairs.

- add a dedicated transcript upsert event or tool-result event
- UI consumes it directly into the normalized store
- maintain a compatibility layer if necessary during rollout

### Phase 4 — Simplify grouping and heuristics

Once stable identities and reconciliation are in place:

- remove orphan/repair logic that is only compensating for unstable upstream ordering
- keep presentation-specific grouping only

Expected cleanup targets after migration:

- out-of-order orphan buffering that only exists to repair synthetic timing issues
- assistant snapshot winner-election paths that only compensate for duplicate live/final representations of the same turn
- tool-result matching fallbacks that exist solely because tool execution items were not first-class upstream

## Expected Benefits

- No post-generation jumping for Claude tool results or assistant/tool cards
- Cleaner reconnect and chunked hydration semantics
- Less brittle UI logic
- Easier future support for other providers with mixed streaming/final transcript behavior

## Risks

- Introducing a normalized store changes the event-handling center of gravity in `App.tsx`
- Backward compatibility for older live event shapes must be preserved during migration
- If assistant partials still lack sufficiently stable identity, some assistant-message finalization rules will need a temporary compatibility path

## Turn lifecycle semantics

`turn_end` remains important even with the normalized store.

It should:

- finalize any open assistant partial for the current turn
- transition in-flight tool execution items that have terminal content into completed status
- clear ephemeral turn bookkeeping (`turnState`) without reordering transcript items
- never replace the transcript array/store wholesale

## Testing Strategy

1. **Reducer/store unit tests**
   - live insert + final reconcile keeps item order stable
   - tool result before/after tool call both converge to same tool execution item
   - `agent_end` finalization does not remount/reorder stable IDs
   - provisional items missing from the final snapshot are abandoned/removed deterministically

2. **UI integration tests**
   - stream a tool call + live result + final snapshot and verify rendered order never changes
   - reconnect during active tool execution: snapshot contains in-progress tool call, followed by live updates for same `toolCallId`, and only one item exists
   - chunked hydration plus later live updates preserves stable order

3. **Claude provider / relay tests**
   - ensure live tool results still surface promptly
   - ensure final sync updates the same logical item rather than creating a second one
   - ensure synthetic migration compatibility maps legacy live tool-result messages onto the same stable item identity

## File Areas Likely Affected

- `packages/ui/src/App.tsx`
- `packages/ui/src/lib/message-helpers.ts`
- new transcript-store module under `packages/ui/src/lib/`
- `packages/ui/src/components/session-viewer/grouping.ts`
- `packages/cli/src/extensions/remote/lifecycle-handlers.ts`
- `packages/cli/src/extensions/remote-types.ts`
- possibly protocol/shared event typings if a new first-class event is added

## Recommendation

Do not keep patching jump symptoms in grouping.

Build a stable transcript model with first-class item identity and reconcile final snapshots into that model. Start by changing the UI state architecture, then promote Claude live tool results into a dedicated transcript event so the viewer no longer has to pretend they are normal message lifecycle events.
