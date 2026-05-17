# Unified Provider Interface — Design Spec

**Date**: 2026-05-06
**Branch**: `feat/unified-provider-interface`
**Status**: Design

## Problem

PizzaPi currently has three separate extension mechanisms:

1. **pi extensions** (`~/.pi/agent/extensions/`) — TypeScript modules subscribing to pi lifecycle events, registering tools/commands
2. **PizzaPi services** (`ServiceHandler` interface) — relay socket, panel hosting, `prepareSessionClose`
3. **MCP servers** (config.json / plugin `.mcp.json`) — tools/resources via stdio/HTTP subprocesses

Plus a fourth quasi-mechanism: **shell hooks** in `config.json` that fire scripts at lifecycle points.

Services like pertinence (a memory/learning engine) need to:
- Inject relevant context into the system prompt each turn
- Index session activity incrementally
- Show their state in the web UI
- Attach metadata to session records

Today, pertinence patches this together with: plugin rules (static markdown), shell hooks at 5 lifecycle points, an MCP server for tools, and a `PizzaPiService` class for the panel + session close. It's fragmented, invisible to users, and there's no clean way for pertinence to say "this turn used directive X."

## Goal

Build a **unified provider interface** in PizzaPi that:

1. **Context injection** — providers inject structured context into the system prompt before each agent turn
2. **Lifecycle hooks** — providers hook into session start/end, turn end, session close
3. **UI extension** — providers contribute sidebar widgets, metadata cards, and panels visible in the web UI
4. **Session metadata** — providers attach typed metadata to session records

This does **NOT** replace MCP for tool provision. It's specifically for lifecycle integration and context injection.

**Pertinence** will be the first consumer — implemented as a standalone provider that tests the API. PizzaPi ships the API; pertinence ships the provider.

## Architecture

### Relationship to existing systems

This provider API **replaces** the lifecycle integration currently scattered across shell hooks and plugin rules. It does **NOT** replace:
- MCP servers (tools remain via MCP)
- Raw socket protocol (providers still get socket access for custom protocols)
- pi extensions (the API is built on top of pi extensions internally)

Migration: existing `ServiceHandler` providers (Terminal, FileExplorer, Git) continue to work. New providers use this API. Existing services can migrate incrementally.

### Tiers:

```
┌─────────────────────────────────────────────────┐
│  pi extension layer                              │
│  (maps pi lifecycle events → provider hooks)     │
│  - before_agent_start → onBeforeAgentStart       │
│  - turn_end → onTurnEnd                          │
│  - session_start → onSessionStart                │
│  - session_shutdown → onSessionShutdown          │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────────────────────────────────┐
│  Runner daemon / relay layer                     │
│  - Provider discovery & loading                  │
│  - UI panel/sidebar hosting                      │
│  - Session metadata relay                        │
│  - onSessionClose coordination (PizzaPi-specific │
│    hook for session finalization, not a pi event) │
└─────────────────────────────────────────────────┘
```

`onSessionShutdown` is pi's runtime teardown (quit, reload, new session). `onSessionClose` is PizzaPi-specific — fired when the PizzaPi server initiates session archival (web UI close button, idle timeout, or daemon shutdown). It runs **before** `session_shutdown`.

## API

### Core Provider Contract

```typescript
interface ExtensionProvider {
  readonly id: string;
  readonly label?: string;
  readonly version?: string;
  /** Explicit capability declaration */
  readonly capabilities: readonly string[];
  init(ctx: ProviderInitContext): Promise<void> | void;
  dispose(): Promise<void> | void;
}

interface ProviderInitContext {
  /** Fire a trigger into any session */
  fireTrigger(sessionId: string, type: string, payload: unknown): Promise<void>;
  /** Access to the relay socket for custom protocols */
  socket: unknown;
  /** Callback to announce updated metadata to the relay */
  publishMetadata(sessionId: string, metadata: Record<string, unknown>): void;
}

interface ProviderContext {
  signal: AbortSignal;
  timeoutMs: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  /** Present only in turn-scoped hooks (onBeforeAgentStart, onTurnEnd). Undefined in session-scoped hooks. */
  promptId?: string;
  turnId?: number;
  isFirstTurn?: boolean;
}
```

### Context Injection

```typescript
interface ContextProvider {
  /** Per-prompt: inject context into the system prompt before the agent starts */
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ProviderContext,
  ): Promise<ContextContribution[] | void>;
}

interface BeforeAgentStartEvent {
  prompt: string;
  images?: Array<{ type: "image"; source: { type: "base64"; mediaType: string; data: string } }>;
  systemPrompt: string;
}

interface ContextContribution {
  text: string;
  placement: "prepend" | "append";
  /** Sort order. Lower = appears first in sorting. Default 100. */
  order?: number;
  /** Same dedupeKey + providerId replaces previous contribution within this prompt */
  dedupeKey?: string;
  summary: string;
  referencedArtifacts?: Array<{
    id: string;
    type: string;
    label: string;
  }>;
}
```

### Lifecycle Hooks

```typescript
interface LifecycleHook {
  onSessionStart?(event: SessionStartEvent, ctx: ProviderContext): Promise<void>;
  onSessionShutdown?(event: SessionShutdownEvent, ctx: ProviderContext): Promise<void>;
  /** Incremental indexing — after each turn completes */
  onTurnEnd?(event: TurnEndEvent, ctx: ProviderContext): Promise<void>;
  /** Best-effort final flush on session close */
  onSessionClose?(event: SessionCloseEvent, ctx: ProviderContext): Promise<SessionCloseResult | null>;
}

interface SessionStartEvent {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

interface SessionShutdownEvent {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

interface TurnEndEvent {
  turnIndex: number;
  message: { role: "assistant"; content: string };
  toolResults?: Array<{ name: string; output: string; isError: boolean }>;
}

interface SessionCloseEvent {
  reason: "close" | "error" | "complete";
  sessionFile: string;
}

interface SessionCloseResult {
  label: string;
  jobRef: Record<string, unknown>;
}
```

### UI Extension

Panels, widgets, and cards are hosted using the existing relay protocol:
- `panel` maps to `service_announce` + `ServicePanelInfo` (serviceId, port, label, icon).
- `sidebarWidgets` and `sessionMetadataCards` render via iframe or API endpoints registered with the tunnel proxy.
- Widget/card content is fetched by the UI client. Providers serve the content over HTTP.

```typescript
interface UIPanelProvider {
  /** Panel announced via service_announce (maps to ServicePanelInfo) */
  panel?: { dir: string; requires?: string[] };
  /** Sidebar widgets rendered in session view */
  sidebarWidgets?: SidebarWidgetDef[];
  /** Metadata cards in session details */
  sessionMetadataCards?: MetadataCardDef[];
}

interface SidebarWidgetDef {
  id: string;
  label: string;
  /** Content served by provider over HTTP */
  source: { type: "html"; dir: string } | { type: "api"; endpoint: string };
}

interface MetadataCardDef {
  id: string;
  label: string;
  source: { type: "html"; dir: string } | { type: "api"; endpoint: string };
}
```

### Session Metadata

Metadata is namespaced by provider ID and flows through the existing relay protocol:
- Provider calls `publishMetadata(sessionId, metadata)` (from `ProviderInitContext`) when state changes.
- PizzaPi attaches `providerId` prefix and relays it as a `session_metadata_update` event.
- UI consumes the namespaced metadata to render provider-specific cards/widgets.
- On session load, metadata is pulled via `getSessionMetadata` and cached. Subsequent updates are push-only.

```typescript
interface MetadataProvider {
  /** Pull metadata for a session (used on initial load / reconnect) */
  getSessionMetadata(sessionId: string, ctx: ProviderContext): Promise<Record<string, unknown>>;
}
```

### Capability Discovery

PizzaPi uses explicit declaration + duck-typing:

```typescript
class PertinenceProvider implements ContextProvider, LifecycleHook, UIPanelProvider, MetadataProvider {
  id = "pertinence";
  capabilities = ["context", "lifecycle", "ui-panel", "metadata"] as const;
  // ... implements all the methods
}
```

PizzaPi checks `capabilities` array, then verifies the required methods exist. If `capabilities` says "context" but `onBeforeAgentStart` is missing, it's a load error.

## Pertinence Reference Implementation

Pertinence will implement all four capabilities:

### Context Injection
- `onBeforeAgentStart`: search pertinence DB for memories/directives matching user's prompt. Return high-confidence matches as `ContextContribution[]`.
- Uses `dedupeKey` so repeated queries don't duplicate context across turns.

Per-turn injection (after tool results) is deferred. Per-prompt injection based on user intent covers pertinence's v1 needs.

### Lifecycle Hooks
- `onSessionStart`: load session state, rehydrate any pending retrospective jobs.
- `onTurnEnd`: scan turn messages for signals (bugs found, corrections made, new learnings). Store incrementally.
- `onSessionClose`: enqueue retrospective job for remaining unscanned content. Return `SessionCloseResult` with label "Finalizing memory…".
- `onSessionShutdown`: flush any pending writes.

### UI Extension
- `panel`: existing pertinence panel (services grid).
- `sidebarWidgets`: memory timeline widget showing recent signals.
- `sessionMetadataCards`: card showing active directives count, recent memories.

### Session Metadata
- Returns pertinence-specific metadata: active directive count, recent memory summaries, pending job count.
- Calls `publishMetadata` (from `ProviderInitContext`) when a turn_end signal is stored or a retrospective job completes, triggering UI refresh.

## Implementation Plan

### Provider discovery
Providers are discovered from `~/.pizzapi/providers/` (user-scoped) and `.pizzapi/providers/` (project-scoped). Each provider is a directory with an `index.ts` entry point that exports an `ExtensionProvider` instance or class.

1. **Provider infrastructure in PizzaPi** — discovery, loading, capability detection, pi event → provider hook mapping
2. **PertinenceProvider** — built in the pertinence repo (not PizzaPi), implementing all four capabilities against the new API
3. **Context injection wiring** — `onBeforeAgentStart` queries pertinence DB, returns `ContextContribution[]`
4. **Lifecycle wiring** — `onTurnEnd` incremental scanning, `onSessionClose` best-effort flush
5. **UI integration** — sidebar widgets + metadata cards via existing relay protocol
6. **Migration & verification** — pertinence replaces old hook scripts with new provider, end-to-end verification

## Provider Configuration

Providers are discovered from `~/.pizzapi/providers/` and `.pizzapi/providers/`. All discovered providers are auto-loaded. To disable a provider, add it to `config.json`:

```json
{
  "providers": {
    "pertinence": { "enabled": false }
  }
}
```

Per-provider configuration is passed via `ProviderInitContext.config` as an opaque JSON object:

```typescript
interface ProviderInitContext {
  /** Per-provider config from config.json ({} if none) */
  config: Record<string, unknown>;
  fireTrigger(sessionId: string, type: string, payload: unknown): Promise<void>;
  socket: unknown;
  publishMetadata(sessionId: string, metadata: Record<string, unknown>): void;
}
```

## Prompt/Turn Semantics

A **prompt** is one user message submission. A **turn** is one LLM response cycle (assistant responds, optionally calls tools). One prompt can have multiple turns if the LLM calls tools inline. Examples:

| Scenario | Prompts | Turns |
|----------|---------|-------|
| User: "Hello" → LLM: "Hi!" | 1 | 1 |
| User: "Read foo.ts" → LLM calls read → sees result → responds | 1 | 2 |
| User: "Fix bug" → LLM calls read → calls edit → responds | 1 | 3 |

`ProviderContext.promptId` is stable across all turns of one user prompt. `turnId` increments each LLM call. `isFirstTurn` is true only for turn 0.

## UI Refresh Contract

Widgets and cards served over HTTP are polled by the UI client. Providers can trigger immediate refresh by calling `publishMetadata`, which emits a `session_metadata_update` event over the relay WebSocket. The UI listens for this event and re-fetches widget/card content for the affected session.

## Phased Rollout

**Phase 1**: Context injection (`ContextProvider`) + lifecycle hooks (`LifecycleHook`). Pertinence switches to this for memory injection and incremental indexing.

**Phase 2**: Session metadata (`MetadataProvider`) + UI extension (`UIPanelProvider`). Sidebar widgets, metadata cards, and the services panel.

This lets pertinence validate the core API before UI contracts are locked.

### Context injection merge ordering
Contributions are sorted by `order` (ascending), then `providerId` (alphabetical). For `prepend`, the sorted list is prepended in order, so contributions with larger `order` values appear closer to the top. For `append`, contributions with smaller `order` values appear closer to the conversation. Default order is 100.

Example (order 10, 50, 100; all prepend):
```
[order=100]  ← closest to top of system prompt
[order=50]
[order=10]
── pi preamble ──
── tool listings ──

### System prompt placement
Prepended text is inserted after pi's preamble but before tool listings and guidelines. Appended text is placed after all pi sections but before any trailing user `appendSystemPrompt`.

### Session metadata relay
Metadata is namespaced by provider ID (e.g., `pertinence.activeDirectives`) and relayed as `session_metadata_update` events. Providers call `publishMetadata` from `ProviderInitContext` for push updates; `getSessionMetadata` is the pull path for initial load and reconnect.

### Panel lifecycle
Panel HTTP servers start in `init()` and stop in `dispose()`. The port is announced via `service_announce` after the server is listening.

### Error isolation
Provider errors in `onBeforeAgentStart` and `onTurnEnd` are caught by PizzaPi. The turn proceeds without the failing provider's contribution. Errors are logged and surfaced in the provider's panel as a degraded state. Providers that fail repeatedly (3 consecutive errors) are temporarily disabled for the remainder of the session. `onSessionClose` errors are logged but do not block session finalization.

### Session close result
`SessionCloseResult.label` is shown in the PizzaPi web UI as a status indicator while the session is being finalized (e.g., "Finalizing memory…"). `jobRef` is an opaque reference stored with the session record so the provider can later correlate completion events. Once finished, the provider calls `publishMetadata` to update the session metadata with results.

### Trust model
Providers run in-process in the PizzaPi runner daemon with the same privileges as pi extensions. They are user-installed code (not sandboxed). The trust boundary is the user's decision to install a provider — same as pi extensions today. PizzaPi does not enforce capability-scoped permissions in v1.
