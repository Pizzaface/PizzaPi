# Action Sigils MVP

**Date:** 2026-03-30
**Status:** Draft
**Builds on:** `docs/superpowers/specs/2026-03-29-sigils-design.md`
**Original Sigils idea by:** [Allen Anthes](https://github.com/AllenAnthes)

## Goal

Add an MVP implementation of **action sigils** on top of PizzaPi's new sigil system so assistant messages can embed lightweight inline interactions without introducing new protocol machinery.

Initial supported forms:

- `[[action:confirm question="Deploy to production?"]]`
- `[[action:choose question="Merge strategy?" options="merge,rebase,squash"]]`
- `[[action:input question="Branch name?" placeholder="feat/..."]]`

For this MVP, action sigils submit **plain chat messages** back into the active session rather than structured protocol events.

## Why This Slice

Action sigils are potentially delightful, but they overlap with `AskUserQuestion`. The highest-value MVP is therefore the thinnest one:

- keep the existing sigil syntax
- render a dedicated interactive inline component for `action:*`
- send responses through the existing viewer → session message path
- avoid protocol changes, service integration, or persistence changes

This gives PizzaPi a conversational inline interaction model while keeping implementation and failure modes small.

## Scope

### In scope

- A dedicated `ActionSigil` UI renderer for `type=action`
- Support for the `confirm`, `choose`, and `input` variants
- Parsing `question`, `options`, and `placeholder` params from existing sigil tokens
- Submitting responses as plain text messages to the active session
- Disabling the action after submission and showing the chosen result
- Graceful fallback when required params are missing or invalid
- Tests for parsing helpers and UI behavior

### Out of scope

- New protocol types or transport changes
- Structured action events or tool invocation semantics
- Multi-select choose actions
- Persisting action completion across page reloads
- Server-side validation or replay protection
- Rich authorization model beyond conservative render rules

## UX Design

The MVP UX should feel lightweight and conversational, but it must avoid accidental duplicate sends and broken controls during streaming or disconnects. Action sigils are independent per token: if a single message contains multiple action sigils, each manages its own local state and may be answered independently.

## Rendering Model

Normal sigils continue to render through `SigilPill`. Action sigils render through a separate `ActionSigil` component selected when:

- `type === "action"`
- `id` is the variant (`confirm`, `choose`, `input`)

This keeps resolve/link/hover-card logic out of the action implementation. Action sigils are not entity references; they are inline controls.

## Variants

### Confirm

Example:

```text
[[action:confirm question="Deploy to production?"]]
```

Render:

- short question label
- two compact buttons
- MVP button labels: `Confirm` and `Cancel`

Rules:

- `question` is required
- clicking either button should optimistically disable both actions immediately to prevent duplicate submits
- `Cancel` means an explicit negative response from the user, not silence or dismissal
- the agent receives `value=cancel` as normal chat text and may interpret it however it chooses

On click:

- submit a plain text message back to the session
- disable both buttons
- show the selected outcome inline

### Choose

Example:

```text
[[action:choose question="Merge strategy?" options="merge,rebase,squash"]]
```

Render:

- question label
- compact list of single-select buttons or chips

Rules:

- `question` is required
- `options` is required
- values are parsed from a comma-separated list
- empty options are discarded
- at least one valid option must remain
- MVP constraint: option values may not contain literal commas; if needed later, add escaping or a different encoding
- clicking an option should optimistically disable the control immediately to prevent duplicate submits

On click:

- submit the selected option as a plain text message
- disable the control
- show the selected option inline

### Input

Example:

```text
[[action:input question="Branch name?" placeholder="feat/..."]]
```

Render:

- question label
- single-line text input
- submit button

Rules:

- `question` is required
- blank submissions are rejected client-side
- `placeholder` is optional
- submit should optimistically disable the form immediately, then either remain completed on success or re-enable on send failure

On submit:

- send the entered value as a plain text message
- disable the control
- show the submitted value inline

## Submission Format

Responses should be easy for both humans and agents to read. For the MVP, the UI sends plain text messages in a consistent format.

Examples:

```text
Action sigil response
variant=confirm
question=Deploy to production?
value=confirm

Action sigil response
variant=confirm
question=Deploy to production?
value=cancel

Action sigil response
variant=choose
question=Merge strategy?
value=squash

Action sigil response
variant=input
question=Branch name?
value=feat/action-sigils
```

Using a short multi-line block avoids ambiguity around freeform values containing delimiter characters like `|`.

Exact wording can be tuned during implementation, but the format should remain:

- explicit that this came from an action sigil
- includes the variant
- includes the original prompt/question
- includes the chosen/submitted value
- uses a predictable delimiter format to reduce prompt-parsing ambiguity

## Trust and Safety

Because action sigils create interactive UI, the MVP should be conservative.

Rules:

- Render interactively only in assistant-authored messages
- If the message role/source cannot be determined safely, fall back to non-interactive rendering
- Do not auto-execute tools or privileged actions
- All responses are plain chat messages; the agent still decides what to do next
- If the session is disconnected, inactive, or ended, actions must be disabled or fail visibly instead of silently dropping the response
- While a message is actively streaming, action sigils should render in a non-interactive pending state and only become clickable once the message is complete
- if message completion is indeterminate (for example after a disconnect mid-stream), default to disabled rather than risking a premature click

This keeps action sigils as a convenience layer, not a privileged control plane.

## Error Handling and Fallbacks

Malformed action sigils should degrade gracefully.

Examples:

- missing `question`
- `choose` with missing/empty `options`
- unknown action variant

Fallback behavior:

- render as a plain fallback sigil / raw syntax instead of broken controls
- do not submit anything automatically
- avoid throwing runtime errors in the message renderer

## Architecture

The architecture goal is to keep action-specific state and submission logic separate from normal sigil resolve/link behavior. Action sigils should not depend on `SigilContext` resolve caching beyond sharing the same parsing/render entry point.

## Component Boundaries

### `ActionSigil`

A new dedicated component responsible for:

- validating variant-specific params
- rendering the inline control
- managing local submitted/disabled state
- formatting the outbound plain-text response
- calling the existing message-send path

### Existing message renderer integration

The sigil rendering bridge should route action sigils separately from normal entity sigils. That routing should happen as close as possible to the current `SigilInline` / span override layer so the rest of the message system stays unchanged.

### Small parsing helpers

Variant-specific helpers should live in a focused utility file rather than inside the component body. For example:

- parse comma-separated options
- normalize labels
- build outbound response text
- validate required params

This keeps the UI component small and makes tests straightforward.

## Data Flow

```text
Assistant markdown
  → rehype sigil span output
  → sigil bridge sees type=action
  → ActionSigil renders variant UI
  → user clicks/submits
  → UI formats plain response text
  → existing viewer message send path
  → active session receives normal chat message
```

No daemon, server, or protocol changes are required for MVP action submission.

## Known Limitations

The MVP intentionally accepts a few limitations:

- action completion is local UI state only and is not persisted across reloads
- refreshing the page can re-enable already-used actions
- plain-text responses are easier to ship now but are less robust than future structured events
- `choose` options do not support embedded commas in this first slice

## Testing Strategy

Add tests for the logic most likely to break:

- action sigil param validation
- options parsing for `choose`
- response-text formatting
- fallback behavior for malformed tokens
- submitted/disabled state after interaction
- duplicate-click prevention
- disabled/pending behavior while the parent message is still streaming
- failure handling when the session is disconnected or message send fails

Prefer fast UI/unit tests over heavier integration harnesses.

## Implementation Notes

Likely touch points:

- `packages/ui/src/components/sigils/ActionSigil.tsx` (new)
- `packages/ui/src/components/sigils/SigilPill.tsx`
- `packages/ui/src/components/ai-elements/message.tsx`
- `packages/ui/src/lib/sigils/*` helper additions as needed

The implementation should follow existing UI patterns and keep action-specific state isolated from resolve/cache behavior in `SigilContext`.

## Recommendation

Implement action sigils as a dedicated UI component on the current branch, with plain-text response submission and no protocol changes. This provides the product value of inline conversational interaction while preserving a small blast radius and a clear upgrade path to structured events later.
