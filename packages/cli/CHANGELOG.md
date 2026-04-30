# Changelog

All notable PizzaPi changes are documented here. Version numbers track the
underlying `@mariozechner/pi-coding-agent` release that each PizzaPi update
ships with — this is how the TUI detects "what's new" on startup.

## [Unreleased]

## [0.70.6] - 2026-04-30

### Upstream (pi 0.67.5 → 0.70.6)

- Refreshed PizzaPi's upstream package set to `@mariozechner/pi-*` `0.70.6`
- Re-ported PizzaPi's existing patches for config-dir flattening, extension session control, retryable JSON stream errors, Anthropic web search, and Claude Code credential fallback
- Added built-in Ollama Cloud provider wiring to the patched upstream packages

### PizzaPi

- **First-party Ollama Cloud provider** — built-in `ollama-cloud` models now target `https://ollama.com/v1` and use `OLLAMA_API_KEY`
- **Bundled Ollama model catalog** — PizzaPi ships a broad initial Ollama Cloud model list, including `glm-5.1`, `gpt-oss`, `kimi`, `qwen`, `deepseek`, `gemma`, and `devstral` families
- **Docs refresh** — installation, getting started, environment-variable, and CLI reference docs now cover Ollama Cloud setup

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
