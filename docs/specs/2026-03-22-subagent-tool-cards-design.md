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
SingleResult.messages[] — synthetic partial Message[] (same shape as pi)
    ↓
SubagentResultCard → AgentExchange component
    ↓  extractToolExecutions() pairs tool calls with results
    ↓
SubagentToolCallsSection component (must be a React component for hook safety)
    ↓  calls renderGroupedToolExecution() per pair
    ↓
Bash terminals, file cards, diffs, write cards, etc.
```

**Note on synthetic messages**: Messages produced by the parser are shape-compatible with pi-ai's `Message` types but lack some required fields (`api`, `provider`, `model`, `usage`, `stopReason` on `AssistantMessage`). The UI accesses messages through loose typing (`{ role: string; content: unknown[] }`) and never passes them to pi-ai functions that expect the full type, so this is safe.

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

Multiple tool calls may appear in sequence, with interleaved assistant text. Consecutive `<tool_call>` blocks before any `<tool_result>` (parallel tool use) are accumulated as content parts in a single `AssistantMessage`, matching pi-ai's convention.

### Parser: `parseSubagentToolCalls(text: string): Message[]`

**Location**: `packages/cli/src/runner/claude-code-ndjson.ts` (pure function, testable)

**Algorithm**:

1. Scan the text for `<tool_call>` markers
2. If none found, return fallback (single text message — current behavior)
3. Split text into segments: plain text, tool call blocks, tool result blocks
4. For each segment:
   - **Plain text** → accumulate into an `AssistantMessage` with `{ type: "text", text }` content
   - **`<tool_call>`** → extract `<tool_name>` and `<tool_input>` (JSON parse into `Record<string, any>`), create a `ToolCall` content part with generated ID (`cc-tc-N`). Consecutive tool calls before any result are grouped as multiple content parts in the same assistant message.
   - **`<tool_result>`** → extract content up to `</tool_result>`, create a `ToolResultMessage` with matching `toolCallId` and `toolName` sourced from the preceding `<tool_call>` block
5. Flush any trailing text as a final assistant message

**Output shape**:

```typescript
[
  { role: "assistant", content: [
    { type: "toolCall", toolCallId: "cc-tc-0", name: "bash", arguments: { command: "head -20 README.md" } }
  ]},
  { role: "toolResult", toolCallId: "cc-tc-0", toolName: "bash", content: [
    { type: "text", text: "# PizzaPi 🍕\nA self-hosted web..." }
  ], isError: false, timestamp: 0 },
  { role: "assistant", content: [
    { type: "text", text: "PizzaPi is a self-hosted web interface and relay server." }
  ]}
]
```

**Key type decisions**:

| Field | Value | Rationale |
|-------|-------|-----------|
| `toolCallId` (not `id`) on ToolCall | `"cc-tc-N"` | Matches NDJSON normalizer convention (`claude-code-ndjson.ts:196`) and UI pairing logic |
| `arguments` on ToolCall | `Record<string, any>` (parsed object) | UI's `extractToolExecutions()` passes it directly as `toolInput` to `renderGroupedToolExecution()`, which calls `parseToolInputArgs()` expecting an object |
| `toolName` on ToolResultMessage | from `<tool_name>` | XML format doesn't carry tool name in `<tool_result>` — parser threads it from the preceding `<tool_call>` block |
| `content` on ToolResultMessage | `[{ type: "text", text }]` array | Matches pi-ai's `(TextContent | ImageContent)[]` format, passed directly to `renderGroupedToolExecution` |

**Error handling**:
- Malformed `<tool_input>` JSON → wrap raw text as `{ raw: text }` in the tool call arguments
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
  toolKey: string;    // unique key for React rendering, e.g. "cc-tc-0"
  toolName: string;   // from the toolCall content part's `name` field
  toolInput: unknown; // from the toolCall content part's `arguments` field (parsed object)
  content: unknown;   // the ToolResultMessage.content array, passed as-is to renderGroupedToolExecution
  isError: boolean;   // from ToolResultMessage.isError
}

function extractToolExecutions(messages: Array<{ role: string; content: unknown[] }>): ToolExecution[]
```

Walks the messages array, pairs `toolCall` blocks (from assistant messages, matched by `toolCallId`) with `ToolResultMessage` entries. Each pair becomes a `ToolExecution`. Unmatched tool calls (no result) are included with `content: null`.

**This function works identically for pi and Claude Code subagents** — both now produce the same messages shape.

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

**`SubagentToolCallsSection` must be a React component** (not a helper function) because `renderGroupedToolExecution` creates child components (e.g. `BashToolCard`) that use hooks (`useSessionActions()`). Hooks require a React component render context.

Each call to `renderGroupedToolExecution` passes:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `toolKey` | `ToolExecution.toolKey` | |
| `toolName` | `ToolExecution.toolName` | |
| `toolInput` | `ToolExecution.toolInput` | Parsed object from `arguments` |
| `content` | `ToolExecution.content` | `ToolResultMessage.content` array as-is |
| `isError` | `ToolExecution.isError` | |
| `isStreaming` | `false` | Subagent is always complete |
| `thinking` | `undefined` | Not available for subagent tool calls |
| `thinkingDuration` | `undefined` | |
| `details` | `undefined` | Leaf tool executions, not nested subagents |

### Collapsible Behavior

`SubagentToolCallsSection` wraps tool cards in a `<details>` element:

- **≤3 tool calls**: auto-open (`open` attribute)
- **>3 tool calls**: collapsed with summary line "N tool calls"

### Visual Treatment

Tool cards inside the subagent bubble have subtle visual nesting:

- Slightly reduced spacing (tighter padding via wrapper class)
- Thin left border or indented container to show these are "nested" operations
- No kill button (subagent is always complete — `isStreaming: false`)

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
| `packages/cli/src/runner/claude-code-ndjson.ts` | Add `parseSubagentToolCalls()` pure function + export |
| `packages/cli/src/runner/claude-code-ndjson.test.ts` | Tests for XML parsing |
| `packages/cli/src/runner/claude-code-bridge.ts` | Call `parseSubagentToolCalls()` in `synthesizeSubagentDetails()` |
| `packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx` | Add `extractToolExecutions()`, add `SubagentToolCallsSection` component, replace `ToolCallActivity` |

## Testing

### Bridge Parser Tests

- Single tool call with result
- Multiple sequential tool calls
- Consecutive tool calls before results (parallel tool use — grouped in one assistant message)
- Interleaved text between tool calls
- Tool call with no matching result (incomplete/truncated)
- Malformed JSON in `<tool_input>`
- No `<tool_call>` tags (fallback to plain text)
- Empty input
- Nested tags (graceful handling)
- Tool result containing JSON text (e.g. read tool output like `{"path": "...", "content": "..."}`)

### UI Rendering

- Manual verification: create a mock `SingleResult` with structured messages, verify tool cards render
- Existing `SubagentResultCard` rendering paths still work (no regression)
- Verify bash, read, edit, write tool types all render correctly inside the subagent card

## Out of Scope

- Streaming subagent tool calls (real-time display as subagent runs) — would require event buffering in bridge
- Capturing subagent usage/token data from Claude Code (not available in current protocol)
- Rendering tool calls for `spawn_session` child sessions (different mechanism)
