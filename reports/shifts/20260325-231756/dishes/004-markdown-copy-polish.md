# Dish 004: Markdown Copy Polish

- **Cook Type:** sonnet
- **Complexity:** M
- **Band:** A (clarityScore=81, riskScore=18, confidenceScore=70)
- **Godmother ID:** — (derived from Service 3 goal)
- **Pairing:** session-viewer-polish (role: main — depends on Dish 003 prelim plating)
- **Paired:** true
- **Pairing Partners:** 003-mobile-overflow-menu
- **Pairing Role:** main
- **Dependencies:** 003 (pairing-dependency — must plate before this dish starts)
- **dispatchPriority:** high (Band A — eligible as soon as 003 plates)
- **Files:**
  - `packages/ui/src/components/ai-elements/code-block.tsx` (add language to context, fenced copy)
  - `packages/ui/src/components/SessionViewer.tsx` (update MessageCopyButton text prop)
- **Verification:** `bun run typecheck` + sandbox visual copy test
- **Status:** ramsey-cleared
- **Session:** 6e2fce1f-cb07-43db-a156-c9fa687e1c27

## Ramsey Report — 2026-03-26 04:15 UTC
- **Verdict:** pass
- **Demerits found:** 2 (P0: 0, P1: 0, P2: 0, P3: 2)
- **Automated gates:** typecheck: pass, tests: 646/0

### Demerits
- P3: Fenced copy doesn't handle code containing triple-backtick (safeFence() exists in export-markdown.ts but not used here)
- P3: exportToMarkdown returns "\n" for empty messages, old code returned ""

### Summary
All structural items clean. Language context, deps, fencing format all correct. Cosmetic only.

## Task Description

### Objective
1. Code block copy: include fenced ` ```language ` wrapper in copied text
2. Per-message copy: use `exportToMarkdown([message])` instead of raw content string

### Branch Setup (base on Dish 003's worktree/branch — this is a pairing)
```bash
# This dish will be dispatched AFTER Dish 003 plates and pairing assembly prepares a combined branch
# The cook will work on the pairing worktree or branch nightshift/dish-004-*
git checkout main
git checkout -b nightshift/dish-004-markdown-copy-polish
```

### Change 1: Add `language` to CodeBlockContext

**File:** `packages/ui/src/components/ai-elements/code-block.tsx`

Find the `CodeBlockContextType` interface and `CodeBlockContext` createContext call. Add `language: string` field.

Find the `CodeBlock` component where `contextValue` is created (around line 434):
```typescript
// Before:
const contextValue = useMemo(() => ({ code }), [code]);
// After:
const contextValue = useMemo(() => ({ code, language }), [code, language]);
```

### Change 2: CodeBlockCopyButton copies with fences

**File:** `packages/ui/src/components/ai-elements/code-block.tsx`

In `CodeBlockCopyButton`, update the destructure:
```typescript
const { code, language } = useContext(CodeBlockContext);
```

Update the clipboard write:
```typescript
// Before:
await navigator.clipboard.writeText(code);
// After:
const fenced = `\`\`\`${language}\n${code}\n\`\`\``;
await navigator.clipboard.writeText(fenced);
```

**Edge cases:**
- `language = "text"` → produces ` ```text\n{code}\n``` ` — valid and correct
- JSON blocks → ` ```json\n{...}\n``` ` — desirable
- Language tags like `"bash"`, `"typescript"` all work identically

### Change 3: MessageCopyButton uses exportToMarkdown

**File:** `packages/ui/src/components/SessionViewer.tsx`

Add import:
```typescript
import { exportToMarkdown } from "@/lib/export-markdown";
```

Find the `MessageCopyButton` usage (search for `<MessageCopyButton` in SessionViewer.tsx). Update the `text` prop:
```tsx
// Before:
text={
  typeof message.content === "string"
    ? message.content
    : message.content != null
      ? JSON.stringify(message.content, null, 2)
      : message.errorMessage ?? ""
}
// After:
text={exportToMarkdown([message])}
```

**Note:** `exportToMarkdown` takes `RelayMessage[]`. The `message` variable here is a `RelayMessage`. Pass `[message]` as the array.

**Verify `exportToMarkdown` handles these message types:**
- Text content (string) — standard assistant/user messages
- Array content blocks (Anthropic format) — tool calls, thinking blocks
- Tool results — should produce tool name + output
- Sub-agent messages

Read `packages/ui/src/lib/export-markdown.ts` to confirm coverage.

### Sandbox Verification (MANDATORY)
```bash
# Build
bun run build

# Start sandbox
screen -dmS sandbox bash -c 'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'
sleep 8
VITE_PORT=$(grep "UI (HMR)" /tmp/sandbox-out.log | grep -o 'localhost:[0-9]*' | cut -d: -f2)

# Log in
playwright-cli open "http://127.0.0.1:${VITE_PORT}"
playwright-cli snapshot
playwright-cli fill <email-ref> "testuser@pizzapi-harness.test"
playwright-cli fill <password-ref> "HarnessPass123"
playwright-cli snapshot
playwright-cli click <sign-in-ref>
sleep 2
playwright-cli screenshot  # screenshot 1: logged in

# Navigate to a session that has messages with code blocks
# Try to click a code block copy button
playwright-cli snapshot  # find a code block copy button
playwright-cli click <copy-button-ref>
playwright-cli screenshot  # screenshot 2: code block copy button in "copied" state

# Clean up
playwright-cli close
screen -S sandbox -X quit
```

**Required evidence:**
- Screenshot showing a code block copy button in active state
- If possible, confirm paste content includes fences (can be noted in dish file text)
- No TypeScript errors on typecheck

### Commit Message
```
feat(ui): fenced code block copy + per-message exportToMarkdown

Code block copy now includes ```language fences so pasted output
is valid markdown. Per-message copy uses exportToMarkdown() to
handle tool calls, thinking blocks, and content arrays correctly.

Closes: Service 3 markdown copy goal
```
