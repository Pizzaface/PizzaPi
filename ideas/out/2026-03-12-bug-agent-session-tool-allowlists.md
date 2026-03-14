---
id: YMaMe2uu
project: PizzaPi
topics:
    - bug
    - agent-sessions
    - tools
    - safety
status: out
created: "2026-03-12T23:14:52-04:00"
updated: "2026-03-13T09:28:15-04:00"
---

Bug: Agent session tool allowlists are applied as raw comma-split strings without normalization/validation, which breaks Claude-style agent tool specs and can silently drop restrictions. In `packages/cli/src/runner/daemon.ts`, `tools` is extracted verbatim from frontmatter (e.g., `.claude/agents/test-runner.md` has `tools: Glob, Grep, LS, Read, ...`). In `packages/cli/src/extensions/initial-prompt.ts`, this string is split and passed directly to `pi.setActiveTools(allowed)`.

Expected: normalize/validate tool names against `pi.getAllTools()` (with alias mapping for Claude casing/names), and apply only valid tools (or fail loudly).
Actual: invalid names are passed through; depending on `setActiveTools` behavior this either leaves the session unrestricted or results in an empty/broken tool set.
Impact: agents can run with wrong permissions (safety regression) or become unusable.
Quick repro: spawn `/agents test-runner` from this repo where `.claude/agents/test-runner.md` uses `Glob, Grep, LS, Read`.
