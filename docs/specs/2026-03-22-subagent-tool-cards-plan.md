# Subagent Tool Card Rendering — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render subagent tool calls (bash, read, edit, write) as proper inline tool cards inside the SubagentResultCard, for both pi and Claude Code sessions.

**Architecture:** Bridge-side XML parser converts Claude Code's `<tool_call>` XML into structured messages matching pi's format. UI extracts tool call+result pairs from the unified messages array and renders them via the existing `renderGroupedToolExecution` renderer. Two independent work streams: bridge (CLI package) and UI.

**Tech Stack:** TypeScript, Bun test runner, React 19

**Spec:** `docs/specs/2026-03-22-subagent-tool-cards-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/cli/src/runner/claude-code-ndjson.ts` | Add `parseSubagentToolCalls()` — pure state-machine XML parser |
| `packages/cli/src/runner/claude-code-ndjson.test.ts` | Tests for the parser |
| `packages/cli/src/runner/claude-code-bridge.ts` | Call parser in `synthesizeSubagentDetails()` |
| `packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx` | Add `extractToolExecutions()` + `SubagentToolCallsSection` component, replace `ToolCallActivity` |

---

## Chunk 1: Bridge — XML Parser

### Task 1: Write `parseSubagentToolCalls` tests

**Files:**
- Modify: `packages/cli/src/runner/claude-code-ndjson.test.ts` (append new describe block)

- [ ] **Step 1: Add test file imports and describe block**

At the bottom of `claude-code-ndjson.test.ts`, add a new describe block for `parseSubagentToolCalls`. Import the function (it doesn't exist yet — tests will fail):

```typescript
import { parseSubagentToolCalls } from "./claude-code-ndjson";

describe("parseSubagentToolCalls", () => {
  // tests go here
});
```

- [ ] **Step 2: Write test — no tool_call tags returns fallback**

```typescript
test("returns single text message when no <tool_call> tags found", () => {
  const result = parseSubagentToolCalls("Just a plain text response.");
  expect(result).toHaveLength(1);
  expect(result[0].role).toBe("assistant");
  expect(result[0].content).toEqual([{ type: "text", text: "Just a plain text response." }]);
});

test("returns single text message for empty input", () => {
  const result = parseSubagentToolCalls("");
  expect(result).toHaveLength(1);
  expect(result[0].role).toBe("assistant");
  expect(result[0].content).toEqual([{ type: "text", text: "" }]);
});
```

- [ ] **Step 3: Write test — single tool call with result**

```typescript
test("parses single tool call with result", () => {
  const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "ls"}</tool_input> </tool_call> <tool_result>
file1.ts
file2.ts
</tool_result>`;

  const result = parseSubagentToolCalls(input);

  // Should produce: assistant (with toolCall) + toolResult
  expect(result.length).toBeGreaterThanOrEqual(2);

  const assistant = result.find(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "toolCall"));
  expect(assistant).toBeDefined();

  const toolCall = (assistant!.content as any[]).find((c: any) => c.type === "toolCall");
  expect(toolCall.name).toBe("bash");
  expect(toolCall.arguments).toEqual({ command: "ls" });
  expect(toolCall.id).toMatch(/^cc-tc-/);

  const toolResult = result.find(m => m.role === "toolResult") as any;
  expect(toolResult).toBeDefined();
  expect(toolResult.toolCallId).toBe(toolCall.id);
  expect(toolResult.toolName).toBe("bash");
  expect(toolResult.isError).toBe(false);
});
```

- [ ] **Step 4: Write test — multiple sequential tool calls**

```typescript
test("parses multiple sequential tool calls", () => {
  const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "pwd"}</tool_input> </tool_call> <tool_result>/home/user</tool_result>

<tool_call> <tool_name>read</tool_name> <tool_input>{"path": "README.md"}</tool_input> </tool_call> <tool_result>
# Hello
</tool_result>`;

  const result = parseSubagentToolCalls(input);
  const toolResults = result.filter(m => m.role === "toolResult");
  expect(toolResults).toHaveLength(2);

  expect((toolResults[0] as any).toolName).toBe("bash");
  expect((toolResults[1] as any).toolName).toBe("read");
});
```

- [ ] **Step 5: Write test — interleaved text between tool calls**

```typescript
test("captures interleaved text between tool calls", () => {
  const input = `Let me check the files.

<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "ls"}</tool_input> </tool_call> <tool_result>file1.ts</tool_result>

Found the file. Now reading it.

<tool_call> <tool_name>read</tool_name> <tool_input>{"path": "file1.ts"}</tool_input> </tool_call> <tool_result>content</tool_result>

Done reviewing.`;

  const result = parseSubagentToolCalls(input);

  // Should have text messages for the interleaved prose
  const textMessages = result.filter(m =>
    m.role === "assistant" && Array.isArray(m.content) &&
    m.content.some((c: any) => c.type === "text")
  );
  expect(textMessages.length).toBeGreaterThanOrEqual(1);

  // Final text should contain "Done reviewing"
  const lastAssistant = [...result].reverse().find(m => m.role === "assistant");
  const lastText = (lastAssistant!.content as any[]).find((c: any) => c.type === "text");
  expect(lastText?.text).toContain("Done reviewing");
});
```

- [ ] **Step 6: Write test — tool_call text inside tool_result is not parsed**

```typescript
test("does not parse <tool_call> inside <tool_result>", () => {
  const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "cat example.xml"}</tool_input> </tool_call> <tool_result>
Here is the file:
<tool_call> <tool_name>fake</tool_name> <tool_input>{"not": "real"}</tool_input> </tool_call>
</tool_result>`;

  const result = parseSubagentToolCalls(input);
  const toolResults = result.filter(m => m.role === "toolResult");
  // Only one real tool call — the fake one inside the result is just text
  expect(toolResults).toHaveLength(1);
  expect((toolResults[0] as any).toolName).toBe("bash");

  // The result content should contain the literal <tool_call> text
  const resultText = (toolResults[0] as any).content[0].text;
  expect(resultText).toContain("<tool_call>");
});
```

- [ ] **Step 7: Write test — malformed JSON in tool_input**

```typescript
test("handles malformed JSON in tool_input", () => {
  const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>not valid json</tool_input> </tool_call> <tool_result>output</tool_result>`;

  const result = parseSubagentToolCalls(input);
  const assistant = result.find(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "toolCall"));
  const toolCall = (assistant!.content as any[]).find((c: any) => c.type === "toolCall");
  // Should have a fallback — raw text wrapped in an object
  expect(toolCall.arguments).toEqual({ raw: "not valid json" });
});
```

- [ ] **Step 8: Write test — missing closing tool_result tag**

```typescript
test("handles missing </tool_result> tag", () => {
  const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "ls"}</tool_input> </tool_call> <tool_result>
output without closing tag`;

  const result = parseSubagentToolCalls(input);
  const toolResult = result.find(m => m.role === "toolResult") as any;
  expect(toolResult).toBeDefined();
  expect(toolResult.content[0].text).toContain("output without closing tag");
});
```

- [ ] **Step 9: Write test — tool result containing JSON text**

```typescript
test("preserves JSON text in tool result (read tool output)", () => {
  const input = `<tool_call> <tool_name>read</tool_name> <tool_input>{"path": "data.json"}</tool_input> </tool_call> <tool_result>{"key": "value", "nested": {"a": 1}}</tool_result>`;

  const result = parseSubagentToolCalls(input);
  const toolResult = result.find(m => m.role === "toolResult") as any;
  expect(toolResult.content[0].text).toBe('{"key": "value", "nested": {"a": 1}}');
});
```

- [ ] **Step 10: Run tests to verify they all fail (function doesn't exist yet)**

Run: `cd packages/cli && bun test src/runner/claude-code-ndjson.test.ts --grep "parseSubagentToolCalls"`
Expected: All tests FAIL with import/reference error

- [ ] **Step 11: Commit test file**

```bash
git add packages/cli/src/runner/claude-code-ndjson.test.ts
git commit -m "test: add parseSubagentToolCalls tests (red phase)"
```

---

### Task 2: Implement `parseSubagentToolCalls`

**Files:**
- Modify: `packages/cli/src/runner/claude-code-ndjson.ts` (add function + export)

- [ ] **Step 1: Add the function signature and export**

At the bottom of `packages/cli/src/runner/claude-code-ndjson.ts`, add:

```typescript
/**
 * Parse Claude Code's XML-serialized subagent tool calls into structured
 * Message-compatible objects. Uses a state machine to avoid misinterpreting
 * <tool_call> text that appears inside <tool_result> blocks.
 *
 * Returns an array of synthetic messages matching pi-ai's Message shape:
 * - AssistantMessage with ToolCall content parts
 * - ToolResultMessage with content and toolName
 *
 * If no <tool_call> tags are found, returns a single assistant text message
 * (backward-compatible fallback).
 */
export function parseSubagentToolCalls(text: string): Record<string, unknown>[] {
```

- [ ] **Step 2: Implement the fallback check**

```typescript
  // Quick check: if no tool_call tags, return plain text fallback
  if (!text.includes("<tool_call>")) {
    return [makeAssistantMessage([{ type: "text", text }])];
  }
```

Add helper at top of function (or as module-level helpers):

```typescript
const STUB_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function makeAssistantMessage(content: Record<string, unknown>[], stopReason = "stop"): Record<string, unknown> {
  return { role: "assistant", content, usage: { ...STUB_USAGE }, stopReason, timestamp: 0 };
}

function makeToolResultMessage(toolCallId: string, toolName: string, content: string, isError = false): Record<string, unknown> {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: content }], isError, timestamp: 0 };
}
```

- [ ] **Step 3: Implement the state machine parser**

```typescript
  const messages: Record<string, unknown>[] = [];
  let assistantContent: Record<string, unknown>[] = [];
  let toolCallCounter = 0;
  let lastToolName = "";
  let lastToolCallId = "";

  type State = "outside" | "in_call" | "in_result";
  let state: State = "outside";
  let pos = 0;

  while (pos < text.length) {
    if (state === "outside") {
      const nextCall = text.indexOf("<tool_call>", pos);
      if (nextCall === -1) {
        // Rest is plain text
        const remaining = text.slice(pos).trim();
        if (remaining) assistantContent.push({ type: "text", text: remaining });
        break;
      }
      // Text before the tool call
      const before = text.slice(pos, nextCall).trim();
      if (before) assistantContent.push({ type: "text", text: before });
      pos = nextCall + "<tool_call>".length;
      state = "in_call";
      continue;
    }

    if (state === "in_call") {
      const endCall = text.indexOf("</tool_call>", pos);
      if (endCall === -1) break; // malformed — bail

      const callBody = text.slice(pos, endCall);

      // Extract tool_name
      const nameMatch = callBody.match(/<tool_name>(.*?)<\/tool_name>/s);
      const toolName = nameMatch ? nameMatch[1].trim() : "unknown";

      // Extract tool_input
      const inputMatch = callBody.match(/<tool_input>(.*?)<\/tool_input>/s);
      const rawInput = inputMatch ? inputMatch[1].trim() : "";
      let toolInput: Record<string, unknown>;
      try {
        toolInput = JSON.parse(rawInput);
      } catch {
        toolInput = { raw: rawInput };
      }

      const toolCallId = `cc-tc-${toolCallCounter++}`;
      lastToolName = toolName;
      lastToolCallId = toolCallId;

      assistantContent.push({ type: "toolCall", id: toolCallId, name: toolName, arguments: toolInput });

      pos = endCall + "</tool_call>".length;

      // Look ahead for <tool_result> — skip whitespace
      const afterClose = text.slice(pos);
      const resultStart = afterClose.match(/^\s*<tool_result>/);
      if (resultStart) {
        // Flush assistant message before entering result
        if (assistantContent.length > 0) {
          messages.push(makeAssistantMessage(assistantContent, "toolUse"));
          assistantContent = [];
        }
        pos += resultStart[0].length;
        state = "in_result";
      } else {
        // Another tool_call might follow (parallel), or text
        const nextCallAhead = afterClose.match(/^\s*<tool_call>/);
        if (nextCallAhead) {
          // Stay and accumulate more tool calls in same assistant message
          pos += nextCallAhead[0].length;
          state = "in_call";
        } else {
          // Flush and go back to outside
          if (assistantContent.length > 0) {
            messages.push(makeAssistantMessage(assistantContent, "toolUse"));
            assistantContent = [];
          }
          state = "outside";
        }
      }
      continue;
    }

    if (state === "in_result") {
      // Only scan for </tool_result> — NOT <tool_call>
      const endResult = text.indexOf("</tool_result>", pos);
      let resultText: string;
      if (endResult === -1) {
        // No closing tag — rest of text is the result
        resultText = text.slice(pos).trim();
        messages.push(makeToolResultMessage(lastToolCallId, lastToolName, resultText));
        break;
      }
      resultText = text.slice(pos, endResult).trim();
      messages.push(makeToolResultMessage(lastToolCallId, lastToolName, resultText));
      pos = endResult + "</tool_result>".length;
      state = "outside";
      continue;
    }
  }

  // Flush any remaining assistant content
  if (assistantContent.length > 0) {
    messages.push(makeAssistantMessage(assistantContent));
  }

  return messages.length > 0 ? messages : [makeAssistantMessage([{ type: "text", text }])];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun test src/runner/claude-code-ndjson.test.ts --grep "parseSubagentToolCalls"`
Expected: All tests PASS

- [ ] **Step 5: Commit implementation**

```bash
git add packages/cli/src/runner/claude-code-ndjson.ts
git commit -m "feat: add parseSubagentToolCalls XML parser"
```

---

### Task 3: Integrate parser into `synthesizeSubagentDetails`

**Files:**
- Modify: `packages/cli/src/runner/claude-code-bridge.ts:988–1020` (the `synthesizeSubagentDetails` function)

- [ ] **Step 1: Add import**

At the top of `claude-code-bridge.ts`, find the existing import from `claude-code-ndjson.ts` and add `parseSubagentToolCalls`:

```typescript
import { translateNdjsonLine, SUBAGENT_TOOL_NAMES, parseSubagentToolCalls } from "./claude-code-ndjson.js";
```

- [ ] **Step 2: Replace messages construction**

In `synthesizeSubagentDetails()`, find line ~1019:

```typescript
messages: resultText ? [{ role: "assistant", content: [{ type: "text", text: resultText }] }] : [],
```

Replace with:

```typescript
messages: resultText ? parseSubagentToolCalls(resultText) : [],
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `cd packages/cli && bun test src/runner/claude-code-ndjson.test.ts`
Expected: All existing tests still PASS

- [ ] **Step 4: Run typecheck**

Run: `cd packages/cli && bunx tsc --noEmit`
Expected: Clean (or only pre-existing errors)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runner/claude-code-bridge.ts
git commit -m "feat: use parseSubagentToolCalls in synthesizeSubagentDetails"
```

---

## Chunk 2: UI — Inline Tool Card Rendering

### Task 4: Add `extractToolExecutions` helper

**Files:**
- Modify: `packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx`

- [ ] **Step 1: Add the ToolExecution interface and extraction function**

Add after the existing `getToolCallCount` function (around line 143):

```typescript
// ── Tool execution extraction ──────────────────────────────────────────

interface ToolExecution {
  toolKey: string;
  toolName: string;
  toolInput: unknown;
  content: unknown;
  isError: boolean;
}

/**
 * Extract tool call + result pairs from the subagent's messages array.
 * Works identically for pi-native messages (id field, object arguments)
 * and Claude Code synthetic messages (id field from parser).
 */
function extractToolExecutions(messages: Array<{ role: string; content: unknown[] }>): ToolExecution[] {
  const executions: ToolExecution[] = [];

  // First pass: collect all tool calls from assistant messages
  interface PendingCall { id: string; name: string; input: unknown }
  const pendingCalls: PendingCall[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type !== "toolCall") continue;

        // Defensive: check both id and toolCallId (pi-ai vs NDJSON normalizer)
        const id = typeof p.toolCallId === "string" ? p.toolCallId
          : typeof p.id === "string" ? p.id
          : "";
        const name = typeof p.name === "string" ? p.name : "unknown";

        // Defensive: handle arguments as object or string
        let input: unknown = p.arguments;
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch { input = {}; }
        }

        pendingCalls.push({ id, name, input });
      }
    }
  }

  // Second pass: match tool results to pending calls
  const matchedIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const m = msg as Record<string, unknown>;
    const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";

    // Find matching pending call
    const matchIdx = pendingCalls.findIndex(c => c.id && c.id === toolCallId && !matchedIds.has(c.id));
    if (matchIdx < 0) continue;

    const call = pendingCalls[matchIdx];
    matchedIds.add(call.id);

    executions.push({
      toolKey: call.id || `tool-${executions.length}`,
      toolName: typeof m.toolName === "string" ? m.toolName : call.name,
      toolInput: call.input,
      content: m.content,
      isError: m.isError === true,
    });
  }

  // Include unmatched calls (no result) — e.g. truncated or still running
  for (const call of pendingCalls) {
    if (call.id && matchedIds.has(call.id)) continue;
    executions.push({
      toolKey: call.id || `tool-${executions.length}`,
      toolName: call.name,
      toolInput: call.input,
      content: null,
      isError: false,
    });
  }

  return executions;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/ui && bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx
git commit -m "feat: add extractToolExecutions helper to SubagentResultCard"
```

---

### Task 5: Add `SubagentToolCallsSection` component

**Files:**
- Modify: `packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx`

- [ ] **Step 1: Add import for renderGroupedToolExecution**

At the top of SubagentResultCard.tsx, add:

```typescript
import { renderGroupedToolExecution } from "@/components/session-viewer/tool-rendering";
```

Also add `ChevronDownIcon` to the lucide-react import if not already there.

- [ ] **Step 2: Add the SubagentToolCallsSection component**

Add after `extractToolExecutions`, before `AgentExchange`:

```typescript
/** Renders inline tool cards for subagent tool calls. Must be a React
 *  component (not a helper function) because renderGroupedToolExecution
 *  creates child components that use hooks (useSessionActions). */
function SubagentToolCallsSection({ executions }: { executions: ToolExecution[] }) {
  if (executions.length === 0) return null;

  const autoOpen = executions.length === 1;

  return (
    <details open={autoOpen || undefined} className="group/tools">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 px-1 py-0.5 hover:text-zinc-400 transition-colors">
          <WrenchIcon className="size-3 shrink-0" />
          <span>{executions.length} tool call{executions.length !== 1 ? "s" : ""}</span>
          <ChevronDownIcon className="size-3 transition-transform group-open/tools:rotate-180" />
        </div>
      </summary>
      <div className="flex flex-col gap-2 pl-1 border-l-2 border-zinc-800 ml-1.5 mt-1 mb-1">
        {executions.map((exec) => (
          <div key={exec.toolKey} className="[&>*]:text-xs">
            {renderGroupedToolExecution(
              exec.toolKey,
              exec.toolName,
              exec.toolInput,
              exec.content,
              exec.isError,
              false,       // isStreaming — always false for completed subagents
              undefined,   // thinking
              undefined,   // thinkingDuration
              undefined,   // details
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd packages/ui && bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx
git commit -m "feat: add SubagentToolCallsSection component"
```

---

### Task 6: Wire up `SubagentToolCallsSection` in `AgentExchange`

**Files:**
- Modify: `packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx` (the `AgentExchange` component, ~line 280)

- [ ] **Step 1: Replace ToolCallActivity with SubagentToolCallsSection**

In the `AgentExchange` component, find:

```tsx
  const finalOutput = getFinalOutput(result.messages);
  const toolCallCount = getToolCallCount(result.messages);
```

Replace with:

```tsx
  const finalOutput = getFinalOutput(result.messages);
  const toolExecutions = extractToolExecutions(result.messages);
```

Then find:

```tsx
      {/* Tool call activity */}
      <ToolCallActivity count={toolCallCount} />
```

Replace with:

```tsx
      {/* Inline tool cards */}
      <SubagentToolCallsSection executions={toolExecutions} />
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/ui && bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session-viewer/cards/SubagentResultCard.tsx
git commit -m "feat: replace ToolCallActivity count with inline tool cards"
```

---

### Task 7: Build and verify

**Files:** All modified files

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: Clean

- [ ] **Step 2: Run all tests**

Run: `bun run test`
Expected: All pass

- [ ] **Step 3: Build everything**

Run: `bun run build`
Expected: Clean build

- [ ] **Step 4: Final commit and push**

```bash
git add -A
git status  # verify only expected files changed
git push -u origin feat/subagent-tool-cards
```

---

## Task Dependency Graph

```
Task 1 (parser tests) → Task 2 (parser implementation) → Task 3 (bridge integration)
                                                                ↓
Task 4 (extractToolExecutions) → Task 5 (SubagentToolCallsSection) → Task 6 (wire up) → Task 7 (build & verify)
```

Tasks 1–3 (bridge) and Tasks 4–5 (UI) can be parallelized if using subagent-driven development. Task 6 depends on both tracks. Task 7 is the final integration check.
