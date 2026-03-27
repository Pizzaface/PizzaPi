# Changelog

All notable PizzaPi changes are documented here. Version numbers track the
underlying `@mariozechner/pi-coding-agent` release that each PizzaPi update
ships with — this is how the TUI detects "what's new" on startup.

## [Unreleased]

## [0.63.1] - 2026-03-27

### Upstream (pi 0.58.3 → 0.63.1)

- **Multi-edit support** — the `edit` tool can now update multiple disjoint regions in one call
- **JSONL session export/import** — `/export path.jsonl` and `/import path.jsonl`
- **Fork sessions** — `--fork <path|id>` copies a session into a new one
- **Resizable sidebar** in HTML share/export views
- **Namespaced keybindings** — unified keybinding manager with configurable `keybindings.json`
- **Built-in tools as extensible ToolDefinitions** — override rendering of read/write/edit/bash tools
- **Typed `tool_call` handler return values** via `ToolCallEventResult`
- Fixed repeated compaction dropping earlier kept messages
- Fixed concurrent `edit`/`write` mutations targeting the same file
- Fixed auto-compaction overflow recovery for Ollama models
- Fixed `@` autocomplete debouncing and stale suggestion cleanup
- Many provider fixes (Bedrock, Google Vertex, OpenRouter, Copilot, MiniMax)

### PizzaPi

- **PizzaPi changelog** — version bumps now show "What's New" in the TUI on first launch, and `/changelog` shows full history
- Ported all patches forward to 0.63.1 (session control, configDir override, version check removal, auth path fix, retryable JSON errors, web search)

## [0.58.3] - 2026-02-25

_Initial changelog tracking. Prior changes are not recorded here._
