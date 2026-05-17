# Sigils

**Date:** 2026-03-29
**Status:** Draft
**Original idea by:** [Allen Anthes](https://github.com/AllenAnthes)

## What Are Sigils?

A **sigil** is a structured inline token embedded in plain text that represents a typed reference to an entity, value, or action. In the same way that Markdown turns `[text](url)` into a clickable link, sigils turn `[[type:id]]` into a rich, interactive UI element — a pill, badge, card, or button — resolved at render time.

The syntax is deliberately minimal:

```
[[type:id]]
[[type:id key=value key="value with spaces"]]
```

Where:

- **type** — the kind of entity being referenced (e.g. `session`, `file`, `status`, `cost`)
- **id** — the primary identifier (a session ID, file path, status label, dollar amount)
- **params** — optional key-value pairs providing extra context or render hints

Examples:

```
[[file:src/auth/login.ts]]
[[session:abc123]]
[[status:healthy]]
[[cost:0.42]]
[[cmd:typecheck run="bun run typecheck"]]
[[error:ENOENT message="No such file: config.json"]]
[[pr:55 status=merged label="Add auth"]]
```

## What Do They Represent?

Sigils are a **structured reference layer** on top of unstructured text. They solve three problems:

### 1. Agent → Human Communication

AI agents produce text. That text is full of references to concrete things — files they edited, commands they ran, errors they hit, sessions they spawned, branches they created. Without sigils, these references are just strings: monospaced text that the human has to parse, copy, and act on manually.

With sigils, the agent writes `[[file:src/auth/login.ts]]` and the human sees a clickable chip that opens the file viewer. The agent writes `[[session:abc123]]` and the human sees a live-status pill they can tap to navigate to that session. The reference becomes **actionable** — it carries meaning the UI can resolve.

### 2. Semantic Structure in a Plain-Text Stream

Chat messages are Markdown strings. Markdown has no concept of "a file reference" or "a test result" or "a session." Sigils inject typed semantics into the stream without requiring a structured message format. The message is still a string — it can be stored, searched, logged, and streamed like any other text. But at render time, the sigil parser extracts the structured tokens and the UI replaces them with appropriate components.

This is the key insight: **the transport stays simple (text), but the presentation is rich (components).**

### 3. An Extensible Vocabulary

Each sigil type is a word in a shared vocabulary between the agent and the UI. Adding a new sigil type means:

1. Define the type name and its semantics
2. Register a component to render it
3. Teach the agent when to use it (system prompt instruction)

No protocol changes. No schema migrations. No new API endpoints. The transport doesn't care — it's still `[[type:id]]` in a text string. Extensibility is at the registration layer, not the wire format.

## Core Architecture

The sigil system is a pipeline with four stages:

```
Text → Parse → Translate → Coalesce → Render
```

### Parse

A regex-based parser scans text for `[[...]]` tokens, skipping anything inside code spans or fenced code blocks. Each match produces a `SigilMatch`:

```typescript
interface SigilMatch {
    type: string                    // "session", "file", "status", etc.
    id: string                      // primary identifier
    params: Record<string, string>  // key-value pairs
    start: number                   // offset in source text
    end: number                     // end offset (exclusive)
    raw: string                     // original "[[...]]" text
}
```

The parser also splits the text into an ordered `RenderSegment[]` array — alternating text segments and sigil segments — preserving the surrounding prose.

### Translate

A translator applies ordered rules to each parsed match, allowing:

- **Type aliases** — `[[bash:cmd]]` → `[[cmd:cmd]]`, `[[sha:abc]]` → `[[commit:abc]]`
- **Alias expansion** — `[[alias:sl]]` → `[[session:abc123]]` (user-defined shorthand)
- **Normalization** — canonicalize types before they hit the renderer

Rules are tried in order; first non-null result wins. If no rule matches, the original match passes through unchanged.

### Coalesce

Adjacent sigils that form a logical group can be fused into a single rendered element. For example, a `[[session:id]]` immediately followed by `[[status:healthy]]` can be coalesced into a single "session + status" pill instead of two separate chips.

Coalescence operates on the segment array, scanning for patterns and merging them into `CoalescedSegment` nodes.

### Render

A **registry** maps type names to components:

```typescript
interface SigilRegistry {
    register(type: string, definition: SigilDefinition): void
    get(type: string): SigilDefinition | undefined
}
```

Each `SigilDefinition` pairs a display component with an optional hover-preview component. The dispatcher looks up the type, renders the matched component, and wraps it in hover cards and pinning affordances as needed.

Unknown types fall through to a monospace fallback pill showing the raw `[[type:id]]` text — the system degrades gracefully.

## Sigil Types (Reference Vocabulary)

The vocabulary is open-ended, but the core types cover the most common agent output:

| Type | ID | Params | What It Renders |
|------|----|--------|-----------------|
| `file` | path | `line` | Clickable file chip → opens file viewer |
| `cmd` | name | `run` | Command pill with the full command |
| `commit` | SHA | `message` | Commit chip linking to diff |
| `branch` | name | | Git branch badge |
| `pr` | number | `status`, `label` | Pull request pill with status indicator |
| `session` | id | `label`, `children`, `activity` | Live session pill with status dot |
| `spawn` | id | | Spawned session reference |
| `status` | label | | Colored status badge |
| `progress` | value | `max`, `label` | Progress indicator |
| `diff` | summary | | Diff stat chip (e.g. +12 -3) |
| `test` | suite | `passed`, `failed` | Test result badge |
| `error` | type | `message` | Error chip with details on hover |
| `cost` | amount | | Dollar-formatted cost pill |
| `duration` | time | | Duration badge (e.g. "3.5s") |
| `timer` | id | `start` | Live elapsed timer |
| `model` | name | | AI model badge with color coding |
| `env` | name | | Environment reference pill |
| `tag` | label | | Generic label/version tag |
| `alert` | level | | Warning/notice/info badge |
| `link` | url | `label` | External link with preview |
| `action` | variant | `question`, `options`, `multi`, `placeholder` | Interactive prompt (confirm, choose, input) |
| `list` | name | | Expandable list (e.g. todos) |
| `pipeline` | id | | Pipeline/workflow reference |

### Type Aliases

Multiple type names can map to the same renderer for natural-language flexibility:

```
task → session        bash, shell → cmd        sha → commit
time, elapsed → timer url, href → link         price, budget → cost
environment → env     agent, llm → model       git-branch, ref → branch
warn, notice → alert  pull-request, mr → pr
```

## Action Sigils — Interactive Prompts

Action sigils are special: they turn a chat message into an interactive prompt. Instead of the agent calling a tool API to ask a question, it writes:

```
[[action:choose options="Merge,Rebase,Squash" question="Which merge strategy?"]]
```

The UI renders radio buttons (or checkboxes with `multi=true`, or a text input with `action:input`). The user's response flows back as a normal chat message. This keeps the interaction inside the conversational stream — no modal dialogs, no separate tool results, no protocol-level machinery.

Action variants:
- **confirm** — yes/no binary choice
- **choose** — select from options (single or multi)
- **input** — free-text entry with optional placeholder

## How Agents Learn the Vocabulary

The agent's system prompt includes a sigil instruction block listing every type, its syntax, and when to use it. The instruction emphasizes **preference for sigils over plain text** — any time the agent mentions a file, command, branch, error, or cost, it should use the sigil form.

This makes sigils an **agent output convention**, not a protocol feature. The agent's text output is still valid Markdown. Clients that don't understand sigils see the raw `[[type:id]]` text — ugly but functional. Sigil-aware clients transform them into interactive UI.

## Markdown Integration

Sigils live inside Markdown text, which means the parser must integrate with the Markdown rendering pipeline. In practice this is a **remark plugin** that:

1. Walks the Markdown AST looking for text nodes
2. Runs the sigil parser on each text node
3. Replaces sigil matches with custom `<span>` elements carrying `data-sigil-*` attributes
4. The React component layer picks up those attributes via a components map override

This keeps the Markdown renderer unmodified — the plugin injects sigil nodes as standard HTML elements that the component layer knows how to render.

### Edge Cases

- **Code spans/blocks** — sigils inside backticks render as raw text (not interactive)
- **GFM autolinks** — URLs containing `[[` can split sigils across AST nodes; the plugin reassembles them
- **Nested brackets** — `[[foo:[[bar]]]]` is rejected (no nesting)

## Pinning

Users can **pin** sigils to a session's header strip — a persistent bar showing key references (the current branch, active file, session cost, etc.) that stay visible across the conversation. Pinning turns a transient in-message reference into a persistent dashboard element.

## Raw Mode

A toggle that switches all sigils in a conversation from rendered components back to syntax-highlighted `[[type:id]]` text — useful for debugging, copying sigil syntax, or understanding what the agent actually wrote.

## Sigils in PizzaPi — Runner Services Integration

The natural home for sigils in PizzaPi is as a **vocabulary extension mechanism** through runner services. A runner service that monitors GitHub PRs can define a `pr` sigil type. A service that tracks costs can define a `cost` sigil type. The service provides:

1. **Type definition** — type name, schema, description (in `manifest.json` alongside trigger definitions)
2. **Render component** — either a pre-built component from PizzaPi's core library, or a custom renderer
3. **Data resolution** — the service can expose an API endpoint that resolves a sigil ID to display data (e.g. PR number → title, status, author)

This means runner services don't just fire triggers — they can also **enrich the chat stream** by teaching the UI how to render new entity types inline.

### Example: A GitHub Service

```json
{
  "id": "github",
  "label": "GitHub",
  "triggers": [...],
  "sigils": [
    {
      "type": "pr",
      "label": "Pull Request",
      "resolve": "/api/resolve/pr/{id}",
      "schema": {
        "id": "number",
        "params": { "status": "string", "label": "string" }
      }
    },
    {
      "type": "commit",
      "label": "Commit",
      "resolve": "/api/resolve/commit/{id}"
    }
  ]
}
```

The agent writes `[[pr:55]]`. The UI sees it's a `pr` type, finds the GitHub service registered it, and optionally calls the resolve endpoint to enrich the display with the PR title and status.

### Example: A Cost-Tracking Service

A usage/billing service registers `[[cost:amount]]` and `[[duration:time]]` sigils. When the agent reports costs inline, they render as properly formatted currency badges. The service's panel shows aggregates; the sigils show per-message detail.

## Design Principles

1. **Text is the wire format.** Sigils are embedded in plain text. No binary protocol, no structured message envelopes. This means they work with any transport that carries strings — Socket.IO events, REST responses, SSE streams, log files.

2. **Graceful degradation.** Unknown sigil types render as monospace fallback pills. Clients that don't understand sigils at all see the raw `[[type:id]]` text. The system never breaks — it just looks less nice.

3. **Agent-native.** Agents emit sigils naturally in their prose. The syntax is simple enough for an LLM to use reliably with a brief system-prompt instruction. No tool calls, no structured output, no separate metadata channel.

4. **Extensible at the edges.** New sigil types are added by registering a component and updating the agent's prompt. The parser, translator, and renderer don't change. Runner services can bring their own types without modifying PizzaPi core.

5. **Interactive where useful.** Most sigils are display-only references. Action sigils turn the chat into an interactive prompt. The same syntax handles both — the type determines the behavior.

6. **Composable.** Sigils can appear anywhere in Markdown prose, mixed with regular text, headers, lists, and code blocks. They're inline elements, not block-level structures (though some types like `session` can optionally render as block cards via params).
