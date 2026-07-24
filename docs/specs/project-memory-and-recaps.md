# Spec: Project Memory + Session Recaps

Godmother epic `Eo9M8M2Bm21jN7VnkmIU3`. Ideas `n431RaJV` (memory), `pkJVsyfs` (recaps).

Two Claude Code–inspired features, built **into the PizzaPi source tree** (not `~/.pizzapi` add-ons). No new dependencies.

## Status: implemented

- `packages/cli/src/extensions/memory/storage.ts` — shared storage module (+ `storage.test.ts`)
- `packages/cli/src/extensions/memory/index.ts` — built-in extension: `memory_*` + `recap` tools, `before_agent_start` context injection, `/memory` + `/recap` commands, resume auto-recap (+ `index.test.ts`)
- registered in `packages/cli/src/extensions/factories.ts`
- `packages/cli/src/runner/services/memory-service.ts` — Web UI backend (list/read/write), registered in `daemon.ts`
- `packages/ui/src/components/MemoryPanel.tsx` — Web UI panel, registered in `service-panels/registry.tsx`

Deferred: auto **idle-refocus** recap in the Web UI (away >3min → background draft). On-demand `/recap` and resume auto-recap ship now; idle-refocus needs App.tsx focus plumbing + background generation — add when wanted.

Note: memory tools are **built-in pi tools** (via `pi.registerTool`), not a separate MCP server. Recaps render in both TUI and Web UI automatically because `pi.sendMessage({display:true})` renders in any attached client.

## Goals

1. **Auto-memory** — a per-project findings store the agent writes to (autonomously + on command) and that auto-loads into every future session. Human-browsable/editable in TUI *and* Web UI.
2. **Recaps** — a one-line "where you left off" summary, on-demand (`/recap`) and automatically on session idle/resume, shown in TUI + Web UI and saved to memory.

## Non-goals

AGENTS.md/CLAUDE.md reimplementation (pi already loads these), `.claude/rules/` path-scoping, `@import` syntax, cross-machine sync, org/managed-policy scopes, full topic-file autoloading heuristics.

---

## Architecture (what we reuse)

| Need | Existing mechanism |
|------|--------------------|
| Auto-inject memory each turn | `ExtensionProvider.onBeforeAgentStart` → `ContextContribution[]` (`type:"memory"` artifact already in the example) |
| React to resume / turn end | `ExtensionProvider` lifecycle: `onSessionStart({reason:"resume"})`, `onTurnEnd`, `onSessionClose` |
| Agent-writable tools | MCP server (mirrors godmother's MCP) |
| Web UI panel | `ServiceHandler` panel (mirrors `~/.pizzapi/services/godmother-panel`) |
| TUI command | Extension slash command (mirrors `packages/cli/src/extensions/*`) |
| Trigger to UI on idle | `ProviderInitContext.fireTrigger` + service trigger def |

`~/.pizzapi/providers/` is currently empty — this ships the first ExtensionProvider.

---

## Storage layout

```
~/.pizzapi/memory/<project-key>/
├── MEMORY.md          # index, loaded every session (cap: 200 lines / 25KB)
├── <topic>.md         # detail files, loaded on demand via memory_read
└── recaps.md          # appended session recaps (session-log)
```

`<project-key>`: `git rev-parse --show-toplevel` basename + short hash (fallback: cwd basename + hash). One dir per repo, shared across worktrees — matches Claude Code semantics. Machine-local, never committed.

---

## Feature 1: Auto-memory

### Injection (provider `memory`)
- `onBeforeAgentStart`: read `MEMORY.md`, truncate to first 200 lines / 25KB, return as one `ContextContribution` (`placement:"prepend"`, `order:60`, `dedupeKey:"project-memory"`, artifact `{type:"memory"}`). Skip if file missing/empty.
- If truncated, append a line noting more detail lives in topic files (agent can `memory_read`).

### Tools (MCP server `memory`)
| Tool | Behavior |
|------|----------|
| `memory_save(summary, detail?, topic?)` | Append a one-line entry to `MEMORY.md` index; if `detail` given, write/append to `<topic>.md` and link it. Enforces cap (warns + suggests trimming when near limit, mirroring Claude Code). |
| `memory_append(topic, text)` | Append to a topic file. |
| `memory_edit(topic, oldText, newText)` | Targeted edit (or `MEMORY.md`). |
| `memory_read(topic)` | Read a topic/detail file on demand. |
| `memory_list()` | List files + index. |

### Autonomous saving
Not a magic feature in Claude Code either — it's prompting + a tool. Ship a plugin rule (`~/.pizzapi/plugins/…/rules` or provider-injected note) instructing the agent to `memory_save` notable findings (build gotchas, corrections, architecture facts) and telling it memory auto-loads next session. `memory_save` is also the manual force-save. Autonomous-but-gated / opt-in variants deferred (YAGNI until asked).

### Human editing surfaces
- **Web UI**: `ServiceHandler` panel `memory-panel` — lists files, view/edit textarea, save via panel API writing to the store. Icon `brain` / `notebook`.
- **TUI**: `/memory` slash command — lists files, opens one in `$EDITOR` (mirrors Claude Code `/memory`). Sub-args `/memory list`, `/memory edit <topic>`.

### Config (`~/.pizzapi/config.json` → `providers.memory`)
`enabled` (default true), `autoMemory` (default true), `memoryDir` (override path), `maxIndexLines`/`maxIndexBytes`.

---

## Feature 2: Recaps

Depends on memory storage (persist target).

### On-demand `/recap`
- TUI slash command + MCP tool `recap`. Reads recent turns from the session JSONL and asks the model to emit one line: "you were <doing X>; <state / what's pending>". Prints it and appends to `recaps.md`.

### Auto on resume
- Provider `onSessionStart({reason:"resume"})`: inject a context contribution instructing the model to open its next response with a one-line recap of prior state; capture that line in `onTurnEnd` and append to `recaps.md`.

### Auto on idle (Web UI)
- Web UI detects tab focus/blur; on refocus after > threshold (default 3 min) with ≥3 turns, fires `memory:recap_requested` trigger → surfaces the latest recap (or requests generation). Mirrors Claude Code's away-summary; TUI keeps `/recap` on-demand (terminal focus isn't observable there).

### Rules / guards
- Skip in non-interactive (`claude -p` / headless) sessions.
- Never twice in a row without fresh activity.
- Toggle + threshold via `providers.memory.recap` config (`enabled`, `idleMinutes`, `minTurns`).

---

## Build order

1. Storage module + project-key resolver + cap enforcement (+ self-check test).
2. MCP `memory` server (tools) — testable headless.
3. `memory` ExtensionProvider — injection + autonomous-save rule.
4. TUI `/memory` command.
5. Web UI `memory-panel` ServiceHandler.
6. Recaps: `/recap` (on-demand) → resume auto → Web UI idle trigger.

Each step lands independently; 1–3 deliver working agent-side memory before any UI.

## Testing

- Storage: unit test cap truncation + project-key derivation.
- MCP tools: headless save/read/list round-trip.
- Provider: injection returns capped contribution; resume triggers recap directive.
- UI: panel edit round-trip via playwright-cli sandbox skill.
