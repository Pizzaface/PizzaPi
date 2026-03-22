# Subagent Tool Card Rendering — Design Spec

**Date**: 2026-03-22  
**Status**: Draft  
**Branch**: `feat/subagent-tool-cards`

## Problem

When a Claude Code worker's subagent (Task/Agent tool) runs tool calls (bash, read, edit, write), the `SubagentResultCard` in the web UI displays the raw `<tool_call>...<tool_result>...` XML text instead of proper tool cards. Pi subagents have structured tool call data in their `messages` array but it's only rendered as a count line ("→ N tool calls"). Neither session type shows what the subagent actually did.

## Goal

Render subagent tool calls as inline tool cards (bash terminals, file type cards, diff views, etc.) inside the `SubagentResultCard` — identically for both pi and Claude Code sessions. The data format unification happens in the bridge; the UI renders from one shape.

## Architecture

Two layers of change:

1. **Bridge** (`packages/cli/src/runner/`): Parse Claude Code's XML into structured messages matching pi's format
2. **UI** (`packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx`): Render tool calls from the unified `messages` array using existing tool card renderers

### Data Flow

```
Claude Code subagent result (raw XML text)
    ↓
synthesizeSubagentDetails() in claude-code-bridge.ts
    ↓  calls parseSubagentToolCalls() from claude-code-ndjson.ts
    ↓
SingleResult.messages[] — structured Message[] (same shape as pi)
    ↓
SubagentResultCard → AgentExchange component
    ↓  extracts tool call + result pairs
    ↓
renderGroupedToolExecution() — existing renderer
    ↓
Bash terminals, file cards, diffs, write cards, etc.
```

## Bridge: XML Parser

### Input Format

Claude Code serializes subagent conversations as text with XML-like tags:

```
<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "head -20 README.md"}</tool_input> </tool_call> <tool_result>
# PizzaPi 🍕
A self-hosted web interface...
</tool_result>

PizzaPi is a self-hosted web interface and relay server.
```

Multiple tool calls may appear in sequence, with interleaved assistant text.

### Parser: `parseSubagentToolCalls(text: string): Message[]`

**Location**: `packages/cli/src/runner/claude-code-ndjson.ts` (pure function, testable)

**Algorithm**:

1. Scan the text for `<tool_call>` markers
2. If none found, return fallback (single text message — current behavior)
3. Split text into segments: plain text, tool call blocks, tool result blocks
4. For each segment:
   - **Plain text** → accumulate into an `AssistantMessage` with `{ type: "text", text }` content
   - **`<tool_call>`** → extract `<tool_name>` and `<tool_input>` (JSON parse), create a `ToolCall` content part with generated ID (`cc-tc-N`)
   - **`<tool_result>`** → extract content up to `</tool_result>`, create a `ToolResultMessage` with matching `toolCallId`
5. Flush any trailing text as a final assistant message

**Output shape** (matches pi-ai `Message[]`):

```typescript
[
  { role: "assistant", content: [
    { type: "toolCall", id: "cc-tc-0", name: "bash", arguments: { command: "head -20 README.md" } }
  ]},
  { role: "toolResult", toolCallId: "cc-tc-0", toolName: "bash", content: [
    { type: "text", text: "# PizzaPi 🍕\nA self-hosted web..." }
  ], isError: false, timestamp: 0 },
  { role: "assistant", content: [
    { type: "text", text: "PizzaPi is a self-hosted web interface and relay server." }
  ]}
]
```

**Error handling**:
- Malformed `<tool_input>` JSON → keep as raw text in the tool call arguments
- Missing `</tool_result>` → treat remaining text as the result
- Nested/recursive tool calls → not expected, handle gracefully (flatten)

### Integration: `synthesizeSubagentDetails()`

**Location**: `packages/cli/src/runner/claude-code-bridge.ts`

Replace the current minimal messages construction:

```typescript
// Before (current):
messages: resultText ? [{ role: "assistant", content: [{ type: "text", text: resultText }] }] : []

// After:
messages: resultText ? parseSubagentToolCalls(resultText) : []
```

If `parseSubagentToolCalls` finds no tool call tags, it returns the same single-message array as before — backward compatible.

## UI: Inline Tool Cards in SubagentResultCard

### Tool Execution Extraction

New helper function in `SubagentResultCard.tsx`:

```typescript
interface ToolExecution {
  toolKey: string;
  toolName: string;
  toolInput: unknown;
  content: unknown;
  isError: boolean;
}

function extractToolExecutions(messages: Array<{ role: string; content: unknown[] }>): ToolExecution[]
```

Walks the messages array, pairs `toolCall` blocks (from assistant messages) with `ToolResultMessage` entries (matched by `toolCallId`). Each pair becomes a `ToolExecution` object — the exact inputs `renderGroupedToolExecution` expects.

### Rendering Changes in `AgentExchange`

Replace the `ToolCallActivity` count line with inline tool cards:

```tsx
// Before:
<ToolCallActivity count={toolCallCount} />

// After:
{toolExecutions.length > 0 && (
  <SubagentToolCallsSection executions={toolExecutions} />
)}
```

`SubagentToolCallsSection` renders each execution via `renderGroupedToolExecution()` inside a collapsible `<details>` wrapper:

- **≤3 tool calls**: auto-open
- **>3 tool calls**: collapsed with "N tool calls" summary

### Visual Treatment

Tool cards inside the subagent bubble have subtle visual nesting:

- Slightly reduced spacing (tighter padding via wrapper class)
- Thin left border or indented container to show these are "nested" operations
- No kill button (subagent is always complete — pass `isStreaming: false`)

### Layout

```
┌──────────────────────────────────────────────┐
│ 🤖 Subagent: summarizer  [user]     ✅ Done │
├──────────────────────────────────────────────┤
│                         ┌────────────────────┤
│                         │ Read the first 20… ││  ← task bubble
│                         └────────────────────┤
│                                              │
│  ▶ 1 tool call                               │  ← collapsible header
│  ┌───────────────────────────────────────┐   │
│  │ $ head -20 .../README.md              │   │  ← bash terminal card
│  │ ┌─ Output ─────────────────────────┐  │   │
│  │ │ # PizzaPi 🍕                     │  │   │
│  │ └──────────────────────────────────┘  │   │
│  └───────────────────────────────────────┘   │
│                                              │
│ ┌────────────────────┐                       │
│ │ PizzaPi is a self… │                       │  ← response bubble
│ └────────────────────┘                       │
├──────────────────────────────────────────────┤
│ 1 turn · ↑12k · ↓3.2k · $0.02               │
└──────────────────────────────────────────────┘
```

### Hook Safety

`renderGroupedToolExecution` calls `useSessionActions()` internally (for the bash kill button). Since subagent results are always complete:

- All tool cards render with `isStreaming: false`
- The kill button never appears
- `useSessionActions()` returns safely (it's already in a `SessionActionsContext` from the parent viewer)

## Files Changed

| File | Change |
|------|--------|
| `packages/cli/src/runner/claude-code-ndjson.ts` | Add `parseSubagentToolCalls()` pure function |
| `packages/cli/src/runner/claude-code-ndjson.test.ts` | Tests for XML parsing — multiple tool calls, interleaved text, malformed input, no tool calls |
| `packages/cli/src/runner/claude-code-bridge.ts` | Call `parseSubagentToolCalls()` in `synthesizeSubagentDetails()` |
| `packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx` | Add `extractToolExecutions()`, replace `ToolCallActivity` with inline tool cards |

## Testing

### Bridge Parser Tests

- Single tool call with result
- Multiple sequential tool calls
- Interleaved text between tool calls
- Tool call with no matching result (incomplete)
- Malformed JSON in `<tool_input>`
- No `<tool_call>` tags (fallback to plain text)
- Empty input
- Nested tags (graceful handling)

### UI Rendering

- Manual verification: create a mock `SingleResult` with structured messages, verify tool cards render
- Existing `SubagentResultCard` rendering paths still work (no regression)

## Out of Scope

- Streaming subagent tool calls (real-time display as subagent runs) — would require Approach B (event buffering)
- Capturing subagent usage/token data from Claude Code (not available in current protocol)
- Rendering tool calls for `spawn_session` child sessions (different mechanism)
