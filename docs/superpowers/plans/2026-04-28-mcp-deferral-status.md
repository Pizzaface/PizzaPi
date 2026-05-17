# MCP Deferral Status Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/mcp` explicitly reflect loaded, deferred/unloaded, and disabled state for MCP servers and tools across CLI and web UI surfaces.

**Architecture:** Expose Tool Search runtime state through a small shared bridge, merge it into the MCP snapshot in `mcp-extension.ts`, propagate the richer snapshot through remote exec/UI parsing, and render explicit state badges in the session viewer MCP card. Use TDD for each behavior change.

**Tech Stack:** Bun, TypeScript, React, PizzaPi CLI extensions, Bun test

---

## Chunk 1: Runtime state plumbing

### Task 1: Expose Tool Search runtime state

**Files:**
- Create: `packages/cli/src/extensions/tool-search-bridge.ts`
- Modify: `packages/cli/src/extensions/tool-search.ts`
- Test: `packages/cli/src/extensions/tool-search.lifecycle.test.ts`

- [ ] Add a shared bridge for Tool Search runtime state.
- [ ] Write/update a failing lifecycle test proving deferred and loaded-on-demand state can be observed externally.
- [ ] Implement the minimal bridge/state export to pass the test.
- [ ] Re-run the targeted lifecycle test.

## Chunk 2: MCP snapshot normalization

### Task 2: Extend `/mcp` snapshot data

**Files:**
- Modify: `packages/cli/src/extensions/mcp-extension.ts`
- Modify: `packages/cli/src/extensions/remote-exec-handler.ts`
- Test: `packages/cli/src/extensions/mcp-extension` test coverage (new or existing)

- [ ] Write a failing test for normalized tool/server states in the MCP snapshot.
- [ ] Implement snapshot normalization for loaded, deferred, partial, and disabled state.
- [ ] Update `/mcp` text output and remote payload handling.
- [ ] Re-run the targeted CLI tests.

## Chunk 3: Web UI rendering

### Task 3: Render explicit MCP states in the viewer

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/components/session-viewer/cards/CommandResultCard.tsx`
- Test: `packages/ui/src/components/session-viewer/cards/CommandResultCard.test.tsx`

- [ ] Write a failing UI test for loaded, deferred/unloaded, partial, and disabled rendering.
- [ ] Implement the minimal UI changes to pass.
- [ ] Re-run the targeted UI tests.

## Chunk 4: Final verification

### Task 4: Verify touched packages

**Files:**
- Test: touched CLI/UI test files

- [ ] Run targeted Bun tests for CLI and UI changes.
- [ ] Run relevant typecheck/build commands for touched packages.
- [ ] Review diff for unintended behavior changes.
