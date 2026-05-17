# Claude Code PizzaPi Compatibility Layer Design

Date: 2026-04-09
Status: Draft

## Summary

Build a PizzaPi-owned compatibility layer that lets sessions executed through the **Claude Code CLI subprocess** behave like near-full PizzaPi runner sessions. Claude remains the reasoning engine, while PizzaPi remains the runtime authority for tools, triggers, question/plan workflows, sigils, child sessions, and UI-visible execution events.

This design intentionally avoids treating the Claude CLI transcript as the source of truth for orchestration. Instead, PizzaPi owns the canonical session transcript and runtime state, and uses Claude session resume/export only as an optimization.

## Goals

- Expose PizzaPi tools to Claude Code sessions with UI-visible tool execution events.
- Preserve PizzaPi-native workflows such as `AskUserQuestion`, `plan_mode`, trigger delivery, and child-session coordination.
- Support runner-provided sigils and trigger discovery in Claude sessions.
- Keep PizzaPi transcript/runtime authoritative so the web UI behaves consistently across providers.
- Reuse MCP-backed capabilities where possible instead of duplicating business logic.

## Non-Goals

- Perfectly reproducing every internal Claude Code CLI behavior.
- Making Claude Code CLI itself the owner of runner lifecycle or PizzaPi session state.
- Replacing existing PizzaPi tool/runtime infrastructure.
- Building a general external Claude Code integration first; PizzaPi-hosted parity is the priority.

## User Experience

From the user’s perspective, a Claude Code session in PizzaPi should:

- show tool calls in the same timeline style as other providers
- be able to call PizzaPi tools and MCP-backed tools
- participate in AskUserQuestion and plan review flows
- receive and respond to triggers
- emit sigils the same way other sessions do
- spawn child sessions and coordinate via existing PizzaPi semantics

The user should not need to care whether a given tool is implemented as a direct PizzaPi tool, an MCP-backed tool, or a compatibility shim.

## Architecture

### 1. Canonical Runtime Ownership

PizzaPi is the system of record for:

- transcript history
- tool execution records
- trigger delivery
- AskUserQuestion and plan review state
- child-session lifecycle
- tunnel state
- sigil discovery

Claude Code CLI is responsible for:

- reasoning over the current context
- selecting tools
- producing assistant output

Claude session export/resume is a cache/continuity optimization only. It must never be treated as the canonical workflow engine.

### 2. Compatibility Adapter

Introduce a Claude-specific compatibility adapter with three responsibilities:

1. **Tool surface synthesis** — advertise PizzaPi capabilities to Claude in a Claude-callable shape.
2. **Runtime translation** — map Claude tool calls/results to PizzaPi-native tool execution events.
3. **Workflow mediation** — handle non-standard workflows like AskUserQuestion, plan review, and trigger injection.

Proposed components and ownership:

- `ClaudePizzaPiCompatProvider` — owns Claude-facing tool registration, tool schema normalization, and mapping between Claude tool names and PizzaPi runtime handlers.
- `ClaudeWorkflowAdapter` — owns workflow semantics that are not ordinary request/response tools: AskUserQuestion, plan review, trigger queueing, child-session coordination, and resume-time continuation decisions.
- `PizzaPiMcpBridge` — reuses and wraps the existing PizzaPi MCP bridge infrastructure to surface MCP-backed tools through the compatibility layer rather than creating a parallel MCP system.

These names are illustrative; exact names can change.

### 3. Tool Exposure Model

Claude-visible tools should include:

- core file tools: `read`, `bash`, `edit`, `write`
- discovery and session tools: `search_tools`, `update_todo`, `spawn_session`, `tell_child`
- workflow tools: `AskUserQuestion`, `plan_mode`, `respond_to_trigger`
- runner/service tools: `list_available_triggers`, `subscribe_trigger`, `unsubscribe_trigger`, `update_trigger_subscription`, `list_available_sigils`
- tunnel tools: `create_tunnel`, `list_tunnels`, `close_tunnel`
- loaded MCP-backed tools, such as Godmother and Jules tools

Each tool call should be executed by PizzaPi’s existing runtime/tool machinery, not by ad hoc Claude-side emulation.

### 4. MCP Bridge

Where capabilities already exist as MCP tools, expose them through the **existing PizzaPi MCP bridge infrastructure** rather than re-implementing each tool specifically for Claude.

Responsibilities:

- enumerate MCP-backed tools PizzaPi has loaded
- normalize tool schemas for Claude Code compatibility
- execute MCP tools through PizzaPi’s existing transport
- return results in PizzaPi-native tool result/event form
- apply an allowlist for v1 so only supported, schema-compatible MCP tools are exposed at first

This allows future reuse by other providers and reduces duplication.

### 5. Workflow Mediation

Triggers and workflow pauses are asynchronous in PizzaPi but Claude CLI turns are synchronous request/response. The compatibility layer must therefore maintain a small adapter-side queue of pending workflow events and flush them at safe turn boundaries. `deliverAs: "steer"` events should be injected before the next Claude turn begins; `deliverAs: "followUp"` events should be queued after the active turn completes.

For v1, a safe turn boundary is detected using the existing Claude stream lifecycle already observed by PizzaPi: the adapter waits until the current Claude response has finished streaming and all tool results for that response have been reconciled into the PizzaPi transcript. Only then may queued trigger/workflow events be injected into the next Claude invocation. This keeps the concurrency model aligned with existing stdin/stdout framing rather than inventing a separate interrupt channel.

Certain PizzaPi capabilities are not ordinary request/response tools and need workflow-aware mediation.

#### AskUserQuestion

When Claude calls `AskUserQuestion`:

- PizzaPi should render the native UI question block
- block until the user answers
- return the user’s response to Claude as a tool result
- if no user is connected or the question is unanswered beyond a timeout/policy window, return a structured timeout/cancel result instead of blocking forever

#### plan_mode

When Claude calls `plan_mode`:

- PizzaPi should render the native plan review block
- wait for approval/edit/cancel
- return the decision in structured form

#### Triggers

Triggers should remain PizzaPi-delivered events. The compatibility layer should:

- inject trigger context into Claude sessions in a controlled format
- preserve trigger IDs and metadata so `respond_to_trigger` can work normally
- avoid flattening everything into plain text if a structured handoff is possible

#### Child Sessions

Child session completion/questions/plans remain managed by PizzaPi. Claude should interact through the same tools the other providers use.

### 6. Transcript and Continuity Rules

PizzaPi already has existing Claude resume/export infrastructure. V1 should **wrap and harden** that path rather than replacing it wholesale. Existing resume/session selection logic stays in place, but the compatibility layer becomes the authority on what gets exported, what gets resent on stdin, and how queued workflow events are merged.

To prevent looping, duplication, and state skew:

- PizzaPi transcript is canonical.
- Claude resume/export should only mirror already-canonical PizzaPi state.
- The adapter must distinguish between:
  - a fresh user prompt that still needs to be sent to Claude
  - a continuation turn where the latest relevant state is already represented in exported session history
- Tool results following a user turn must not cause the user prompt to be resent.

### 7. UI Event Parity

The compatibility layer must emit PizzaPi-native runtime events so the web UI can render:

- tool start/update/end
- tool errors
- AskUserQuestion blocks
- plan review blocks
- trigger messages
- child-session events
- attachments and file references

The UI should not need Claude-specific hacks for core tool behavior.

For long-running tools, the provider should emit normal PizzaPi `tool_execution_start` immediately, then stream intermediate updates when the underlying PizzaPi tool runtime supports them. If a Claude tool protocol path only allows a single final tool result, the adapter should still preserve UI progress via PizzaPi-side events.

### 8. Sigil Support

Sigils remain runner-discovered.

Flow:

1. PizzaPi queries available sigils from the runner.
2. Claude receives guidance about which sigil types are available.
3. Claude may emit `[[type:id]]` references only for supported types.
4. PizzaPi UI resolves and renders them.

No Claude-native sigil support is required.

## Tool Naming and Safety

### Tool Naming

Claude Code CLI has its own built-in tool concepts. To avoid collisions, the compatibility layer should namespace PizzaPi-owned tools in the Claude-facing registration layer when necessary, while still rendering their canonical PizzaPi names in the PizzaPi UI. The exact Claude-facing naming scheme can be decided during implementation, but collision avoidance is a hard requirement.

### Security and Sandbox

All tool execution must continue to respect PizzaPi sandbox and safe-mode controls. The compatibility layer must not bypass existing enforcement for:

- filesystem access
- shell/network restrictions
- tunnel creation permissions
- session spawning limits

If a tool is blocked by sandbox policy, the adapter should return the same style of structured error PizzaPi returns today.

## Data Flow

### Tool Call Flow

1. Claude CLI emits a `tool_use` block.
2. The Claude compatibility provider maps that block to a PizzaPi tool handler.
3. PizzaPi emits `tool_execution_start`.
4. The underlying tool runs through PizzaPi runtime or existing MCP bridge.
5. PizzaPi streams updates if supported.
6. PizzaPi emits `tool_execution_end`.
7. The adapter converts the final PizzaPi tool result into the Claude `tool_result` shape.
8. The transcript stores the PizzaPi-native event/result records.

### Trigger Flow

1. Runner service fires a trigger.
2. PizzaPi delivers it to the subscribed Claude session.
3. If Claude is idle, the compatibility layer injects structured trigger context into the next Claude turn immediately.
4. If Claude is mid-turn, the trigger is queued according to `steer` vs `followUp` semantics and delivered at the next safe turn boundary.
5. Claude may respond with `respond_to_trigger`.
6. PizzaPi performs the authoritative trigger response action.

### Question / Plan Flow

1. Claude requests `AskUserQuestion` or `plan_mode`.
2. PizzaPi renders the native UI block.
3. User responds through the web UI.
4. PizzaPi converts the response into a tool result.
5. Claude continues from that result.

## Failure Handling

- If a PizzaPi tool fails, return the real tool error to Claude and record it in the transcript.
- Distinguish permanent schema/permission errors from transient execution errors so retries are not applied blindly.
- If an MCP-backed tool cannot be normalized for Claude, mark it unavailable rather than exposing a broken schema.
- If workflow state becomes inconsistent, PizzaPi should fail closed and keep its own transcript authoritative.
- If Claude resume/export diverges from PizzaPi transcript, rebuild the Claude-side session mirror from canonical PizzaPi state.
- If AskUserQuestion/plan workflows time out or lose their UI consumer, return a structured non-success result rather than hanging forever.

## Observability

Add debug logging and counters for:

- Claude tool registration and filtering
- tool-call name mapping
- queued vs immediately delivered triggers
- AskUserQuestion / plan workflow wait durations
- session rebuild vs reuse decisions
- dropped/unsupported MCP tools

This is required for diagnosing transcript drift and workflow deadlocks.

## Testing Strategy

Add coverage for:

- core tool invocation parity (`read`, `bash`, `edit`, `write`)
- MCP-backed tool exposure and execution
- AskUserQuestion round-trip
- `plan_mode` round-trip
- trigger delivery + `respond_to_trigger`
- child session coordination
- sigil discovery propagation
- transcript continuity after tool results, triggers, and workflow pauses
- no duplicate prompt resend after exported tool-result continuations
- tool naming collision handling
- timeout behavior for user-blocking workflows
- trigger queue delivery ordering
- sandbox-enforced failures through the compatibility layer

Tests should verify both runtime behavior and emitted PizzaPi UI events.

## Incremental Implementation Plan

### Phase 1 — Compatibility Tool Registry

- define the Claude-visible compatibility tool registry in code
- route existing PizzaPi tools through the registry
- add collision-safe Claude-facing tool naming
- ensure UI-visible tool events are preserved

**Done when:** a Claude session can call core PizzaPi tools and the web UI shows normal tool timeline events.

### Phase 2 — MCP Bridge

- expose allowlisted MCP tools through the existing MCP bridge via a normalized adapter
- support schema/result translation for Claude
- log unsupported MCP tools explicitly

**Done when:** at least one representative MCP tool group is callable from Claude with preserved UI events.

### Phase 3 — Workflow Tools

- wire `AskUserQuestion`
- wire `plan_mode`
- wire `respond_to_trigger`
- add timeout/cancel behavior for blocking workflows

**Done when:** question/plan flows round-trip through the UI and return structured results to Claude.

### Phase 4 — Trigger and Session Orchestration

- support trigger injection and subscription tools
- add queued delivery at turn boundaries
- verify child-session behavior in Claude sessions
- define default child-session provider behavior explicitly

**Done when:** subscribed triggers and child-session events are handled without transcript corruption or dropped actions.

### Phase 5 — Continuity Hardening

- make PizzaPi transcript fully canonical
- reduce reliance on fragile Claude transcript assumptions
- add duplicate/loop regression coverage
- wrap existing resume/session-selection behavior instead of replacing it

**Done when:** resumed Claude sessions survive tools, triggers, and workflow pauses without crashes or duplicate prompt replay.

### Phase 6 — Polish

- confirm sigil behavior
- improve diagnostics for unsupported tools/workflows
- verify UI parity across representative user flows
- document migration behavior for new vs existing Claude sessions

**Done when:** the feature is diagnosable, documented, and stable across representative parity scenarios.

## Trade-offs

### Why not MCP-only?

MCP-only is attractive for basic tools, but weak for PizzaPi-native orchestration semantics like AskUserQuestion, plan review, and triggers. Those need a workflow-aware adapter.

### Why not keep Claude session state canonical?

Because PizzaPi must render consistent UI/runtime behavior across providers and workflows. Making Claude canonical would create drift and make PizzaPi-specific flows fragile.

### Why hybrid adapter + MCP?

It keeps orchestration local to PizzaPi while reusing existing capability surfaces where they already exist. That gives the best balance of parity and maintainability.

## Resolved v1 Decisions

- Claude is invoked via the existing Claude Code CLI subprocess integration, not replaced with a direct Anthropic API provider.
- The compatibility layer wraps the existing Claude resume/export infrastructure; it does not replace resume logic in v1.
- MCP exposure is allowlisted for v1, not fully dynamic.
- Unsupported workflow primitives should be hidden or marked unavailable rather than exposed as broken tools.
- Child sessions spawned from a Claude parent inherit the parent provider by default unless the caller explicitly overrides model/provider selection.

## Open Questions

- Which Claude Code CLI tool schema features are unavailable or constrained relative to PizzaPi tools?
- What Claude-facing names should be used to avoid collisions while keeping PizzaPi UI names canonical?
- Which allowlisted MCP tool groups are in-scope for v1?

## Recommendation

Proceed with a **hybrid compatibility adapter + MCP bridge**.

This is the best fit for near-total PizzaPi parity because it:

- keeps PizzaPi in control of runtime semantics
- lets Claude operate as the reasoning engine
- preserves the existing UI model
- reduces long-term duplication by reusing MCP-backed capabilities
