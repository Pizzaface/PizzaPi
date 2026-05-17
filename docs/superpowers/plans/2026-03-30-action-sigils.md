# Action Sigils MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MVP action sigils that render inline confirm/choose/input controls inside assistant messages and submit plain chat responses back to the active session.

**Architecture:** Keep normal entity sigils on the existing `SigilPill` path and add a separate `ActionSigil` renderer for `type=action`. Route action sigils through the existing sigil span bridge, use small parsing/formatting helpers for validation, and submit responses through the existing viewer `socket.emit("input")` path with local completion state only.

**Tech Stack:** React 19, TypeScript, Bun test, existing PizzaPi sigil parser/rehype integration, Socket.IO viewer input flow.

---

## File map

- Modify: `packages/ui/src/components/sigils/SigilPill.tsx`
  - Route `type=action` away from the hover/resolve pill path.
- Create: `packages/ui/src/components/sigils/ActionSigil.tsx`
  - Render confirm/choose/input UI, manage local pending/completed/error state, submit plain chat responses.
- Create: `packages/ui/src/lib/sigils/actions.ts`
  - Parse action params, validate variants, normalize choose options, build response text.
- Create: `packages/ui/src/lib/sigils/actions.test.ts`
  - Unit tests for parsing/validation/formatting helpers.
- Modify: `packages/ui/src/components/sigils/index.ts`
  - Export `ActionSigil` if needed by current barrel pattern.
- Modify: `packages/ui/src/components/ai-elements/message.tsx`
  - Pass any message-level metadata needed to know whether the message is assistant-authored and complete.
- Modify: `packages/ui/src/components/session-viewer/message-item.tsx`
  - Thread message role / streaming completion information down if the current renderer boundary does not already expose it.
- Modify: `packages/ui/src/lib/sigils/parser.test.ts`
  - Verify early that `[[action:confirm ...]]` parses as `type=action`, `id=confirm`, then add regression coverage.
- Optional modify: `packages/ui/src/App.tsx`
  - Only if a small reusable helper or prop plumbing is needed to reuse the existing viewer input send logic safely.

---

## Chunk 1: Action helper logic

### Task 1: Add helper types and parsing rules

**Files:**
- Create: `packages/ui/src/lib/sigils/actions.ts`
- Test: `packages/ui/src/lib/sigils/actions.test.ts`

- [ ] **Step 1: Write the failing parser + helper tests**

Cover:
- parser emits `type=action` and `id=<variant>` for action sigils
- valid `confirm` with required `question`
- valid `choose` with `options="merge,rebase,squash"`
- choose drops empty options and rejects all-empty input
- choose rejects literal-comma edge cases only by treating commas as separators (documented MVP constraint)
- valid `input` with optional placeholder
- unknown variant returns invalid result
- missing `question` returns invalid result
- response formatting produces the expected multi-line plain-text block

Example shape:

```ts
import { describe, expect, test } from "bun:test";
import { parseActionSigil, buildActionResponse } from "./actions";

test("parses choose options", () => {
  expect(parseActionSigil("choose", {
    question: "Merge strategy?",
    options: "merge,rebase,squash",
  })).toEqual({
    kind: "choose",
    question: "Merge strategy?",
    options: ["merge", "rebase", "squash"],
  });
});
```

- [ ] **Step 2: Run the helper tests and verify they fail**

Run:
```bash
cd /Users/jordan/Documents/Projects/PizzaPi
bun test packages/ui/src/lib/sigils/parser.test.ts
bun test packages/ui/src/lib/sigils/actions.test.ts
```

Expected: FAIL because the helper file does not exist yet and/or parser expectations are not yet covered.

- [ ] **Step 3: Implement minimal helper logic**

Implement focused helpers such as:
- `parseActionSigil(variant, params)`
- `buildActionResponse(action, value)`
- any small internal helpers for splitting/normalizing options

Keep return types explicit. Prefer discriminated unions over loose objects.

- [ ] **Step 4: Re-run parser + helper tests and make them pass**

Run:
```bash
cd /Users/jordan/Documents/Projects/PizzaPi
bun test packages/ui/src/lib/sigils/parser.test.ts
bun test packages/ui/src/lib/sigils/actions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit helper logic**

```bash
git add packages/ui/src/lib/sigils/actions.ts packages/ui/src/lib/sigils/actions.test.ts packages/ui/src/lib/sigils/parser.test.ts
git commit -m "feat(ui): add action sigil parsing helpers"
```

---

## Chunk 2: Dedicated action renderer

### Task 2: Build `ActionSigil` with local state and safe fallbacks

**Files:**
- Create: `packages/ui/src/components/sigils/ActionSigil.tsx`
- Modify: `packages/ui/src/components/sigils/index.ts`
- Test: `packages/ui/src/lib/sigils/actions.test.ts`

- [ ] **Step 1: Add concrete renderer-facing tests**

Use the lightest existing UI test pattern already present in `packages/ui`, but do add direct renderer coverage for:
- invalid action falls back cleanly
- confirm disables immediately after click
- choose disables immediately after option click
- input rejects blank submission
- two action sigils in one message manage state independently
- keyboard/button accessibility basics (button labels, disabled state exposed)

- [ ] **Step 2: Run the relevant tests to verify the gap**

Run either the new UI test file or the expanded helper suite.

- [ ] **Step 3: Implement `ActionSigil.tsx`**

Requirements:
- accept `variant`, `params`, raw sigil text, and submission hooks/permissions as props
- use `parseActionSigil()` to validate
- render:
  - confirm: question + Confirm/Cancel buttons
  - choose: question + option buttons/chips
  - input: question + text field + submit
- optimistically disable on first submit/click to prevent duplicate sends
- show submitted value inline after success
- on malformed input, return a compact raw/fallback rendering instead of throwing
- keep styling touch-friendly and visually distinct from normal sigil pills

- [ ] **Step 4: Re-run the targeted tests**

Run the same test command(s) used in Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the renderer**

```bash
git add packages/ui/src/components/sigils/ActionSigil.tsx packages/ui/src/components/sigils/index.ts packages/ui/src/lib/sigils/actions.test.ts
git commit -m "feat(ui): add action sigil renderer"
```

---

## Chunk 3: Wire action sigils into message rendering

### Task 3: Route `type=action` through the new renderer

**Files:**
- Modify: `packages/ui/src/components/sigils/SigilPill.tsx`
- Modify: `packages/ui/src/components/ai-elements/message.tsx`
- Modify: `packages/ui/src/components/session-viewer/message-item.tsx`
- Optional modify: `packages/ui/src/components/session-viewer/rendering.tsx`

- [ ] **Step 1: Identify the smallest prop path for message metadata**

Trace where sigil span nodes become React components and determine the minimum metadata needed by `ActionSigil`:
- is this an assistant-authored message?
- is the message complete or still streaming?
- how can the component submit a plain viewer input message?

Document the exact prop plumbing in code comments if the path is non-obvious.

- [ ] **Step 2: Add the failing integration test(s)**

Add a focused test that proves assistant messages can render action sigils while unsupported contexts fall back. Also cover the streaming → complete transition so an action starts disabled and becomes interactive only after completion.

- [ ] **Step 3: Implement the routing changes**

Requirements:
- route `type=action` to `ActionSigil`
- keep all existing behavior unchanged for non-action sigils
- only enable interactivity for assistant messages
- keep action sigils disabled while the parent message is still streaming or completion is indeterminate
- fall back to a non-interactive/raw rendering in any unsupported context

- [ ] **Step 4: Re-run targeted UI tests**

Run the specific test files touched in this task.

- [ ] **Step 5: Commit the wiring**

```bash
git add packages/ui/src/components/sigils/SigilPill.tsx packages/ui/src/components/ai-elements/message.tsx packages/ui/src/components/session-viewer/message-item.tsx packages/ui/src/components/session-viewer/rendering.tsx
git commit -m "feat(ui): wire action sigils into message rendering"
```

---

## Chunk 4: Reuse existing viewer input flow

### Task 4: Submit action responses through the existing chat input path

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/components/sigils/ActionSigil.tsx`
- Optional modify: any small hook/context file used to avoid prop-drilling

- [ ] **Step 1: Extract or expose the smallest reusable send-message hook/callback**

Use the existing viewer input behavior rooted at `packages/ui/src/App.tsx` (`socket.emit("input", { text, ... })`).

Do **not** duplicate send logic inside `ActionSigil`. Instead, expose a narrow callback such as:
- `sendViewerInput(text: string): Promise<{ ok: boolean; error?: string; reason?: "disconnected" | "inactive" | "ended" | "unknown" }>`

Keep attachments and other composer concerns out of the action path.

- [ ] **Step 2: Add tests for response formatting and failure handling**

At minimum verify:
- the exact multi-line message produced for each variant
- input values containing punctuation like `=` and `|` still serialize safely in the multi-line format
- a failed send does not leave the control permanently stuck in pending state
- disconnected/inactive/ended reasons map to visible non-success UI states

- [ ] **Step 3: Implement the submission plumbing**

Requirements:
- action sigil submit uses the shared send callback
- send failure is visible in the control and re-enables retry where appropriate
- disconnected/inactive session state disables or blocks action sends clearly

- [ ] **Step 4: Run the targeted tests**

Run the smallest set of UI/unit tests covering submission behavior.

- [ ] **Step 5: Commit submission plumbing**

```bash
git add packages/ui/src/App.tsx packages/ui/src/components/sigils/ActionSigil.tsx
git commit -m "feat(ui): send action sigil responses through viewer input flow"
```

---

## Chunk 5: Regression coverage and verification

### Task 5: Extend parser coverage and run verification

**Files:**
- Modify: `packages/ui/src/lib/sigils/parser.test.ts`
- Modify: any newly added action test files

- [ ] **Step 1: Add parser regression tests**

Cover:
- `[[action:confirm question="Deploy?"]]`
- `[[action:choose question="Merge strategy?" options="merge,rebase,squash"]]`
- `[[action:input question="Branch name?" placeholder="feat/..."]]`
- ensure sigils inside code blocks/spans still remain raw text

- [ ] **Step 2: Run parser and action-focused tests**

Run:
```bash
cd /Users/jordan/Documents/Projects/PizzaPi
bun test packages/ui/src/lib/sigils/parser.test.ts
bun test packages/ui/src/lib/sigils/actions.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package-level UI tests**

Run:
```bash
cd /Users/jordan/Documents/Projects/PizzaPi
bun test packages/ui
```

Expected: PASS.

- [ ] **Step 4: Run repo verification**

Run:
```bash
cd /Users/jordan/Documents/Projects/PizzaPi
bun run typecheck
bun run build
```

Expected: PASS.

- [ ] **Step 5: Commit verification-driven cleanup**

```bash
git add -u
git add packages/ui/src/lib/sigils/parser.test.ts packages/ui/src/lib/sigils/actions.test.ts
git commit -m "test(ui): cover action sigils and finalize MVP"
```

---

## Execution notes

- Keep this work on the current branch: `feat/manifest-split` (per explicit user request for this conversation)
- Do not introduce protocol/server changes for MVP action submission
- Preserve existing sigil resolve behavior for non-action sigils
- Prefer focused helpers and narrow prop plumbing over broad context rewrites
- If message-completion metadata is hard to access cleanly, default to disabled rather than making action sigils clickable too early

## Review checklist

Before execution handoff, confirm:
- action sigils only interact in assistant messages
- duplicate clicks are blocked
- disconnected-session failure is visible
- input values with punctuation still format correctly in outbound messages
- non-action sigils are unchanged
- repo typecheck/build still pass

Plan complete and saved to `docs/superpowers/plans/2026-03-30-action-sigils.md`. Ready to execute?