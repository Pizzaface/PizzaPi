# Claude Code PizzaPi Compatibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code CLI sessions inside PizzaPi behave like near-full PizzaPi runner sessions for tools, MCP-backed capabilities, workflow tools, triggers, sigils, and UI-visible runtime events.

**Architecture:** Keep PizzaPi as the canonical runtime/transcript owner and treat the Claude CLI subprocess as the reasoning engine. Add a Claude compatibility layer that translates Claude tool use into PizzaPi-native tool execution, wraps the existing MCP bridge for allowlisted MCP tools, and mediates asynchronous workflows like AskUserQuestion, plan review, and trigger delivery at safe turn boundaries.

**Tech Stack:** TypeScript, Bun test runner, PizzaPi CLI extensions, Claude Code CLI subprocess bridge, existing PizzaPi MCP extension/bridge infrastructure.

---

## File Map

### Existing files to modify

- `packages/cli/src/extensions/claude-code-provider/extension.ts`
  - Register the compatibility layer and feed it session/runtime context.
- `packages/cli/src/extensions/claude-code-provider/stream.ts`
  - Intercept Claude tool calls/results, queue workflow events, and map Claude turns to PizzaPi runtime events.
- `packages/cli/src/extensions/claude-code-provider/session-bridge.ts`
  - Keep canonical transcript export/resume behavior aligned with continuation semantics.
- `packages/cli/src/extensions/claude-code-provider/types.ts`
  - Extend provider config/types for compat registry, workflow queueing, and MCP allowlist settings.
- `packages/cli/src/extensions/mcp-bridge.ts`
  - Reuse active MCP bridge access for Claude compatibility execution.
- `packages/cli/src/extensions/mcp-extension.ts`
  - Expose any helper accessors needed by the Claude compatibility layer.
- `packages/cli/src/extensions/remote-ask-user.ts`
  - Reuse question workflow behavior for structured AskUserQuestion round-trips.
- `packages/cli/src/extensions/remote-plan-mode.ts`
  - Reuse plan review workflow behavior for structured plan_mode round-trips.
- `packages/cli/src/extensions/trigger-client.ts`
  - Reuse trigger metadata/response plumbing for Claude-trigger compatibility.
- `packages/cli/src/extensions/tunnel-tools.ts`
  - Ensure tunnel tools are exposed through the Claude compatibility registry.
- `packages/cli/src/extensions/remote-trigger-response.ts`
  - Reuse trigger response action plumbing when Claude responds to pending triggers.
- `packages/cli/src/extensions/remote.ts`
  - Hook provider-aware child session defaults if needed for inherited Claude provider behavior.

### New files to create

- `packages/cli/src/extensions/claude-code-provider/compat-registry.ts`
  - Build the Claude-visible tool registry and map Claude-facing names to PizzaPi handlers.
- `packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts`
  - Unit tests for allowlisting, name collisions, and tool lookup.
- `packages/cli/src/extensions/claude-code-provider/workflow-adapter.ts`
  - Mediate AskUserQuestion, plan_mode, trigger queueing, and turn-boundary delivery.
- `packages/cli/src/extensions/claude-code-provider/workflow-adapter.test.ts`
  - Tests for queue ordering, timeout behavior, and structured workflow results.
- `packages/cli/src/extensions/claude-code-provider/mcp-compat.ts`
  - Wrap the existing MCP bridge with Claude-compatible schemas/results for an allowlisted tool subset.
- `packages/cli/src/extensions/claude-code-provider/mcp-compat.test.ts`
  - Tests for schema normalization, unsupported-tool filtering, and execution mapping.

### Existing tests to expand

- `packages/cli/src/extensions/claude-code-provider/stream.test.ts`
- `packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`
- `packages/cli/src/extensions/mcp.test.ts`
- `packages/cli/src/extensions/remote-ask-user.test.ts`
- `packages/cli/src/extensions/remote-plan-mode.test.ts`
- `packages/cli/src/extensions/remote-trigger-response.test.ts`
- `packages/cli/src/extensions/trigger-client.test.ts`
- `packages/cli/src/extensions/tunnel-tools.test.ts`

---

## Resolved v1 planning decisions

- Claude-facing tool names should preserve canonical PizzaPi names when possible and use a deterministic `pizzapi__<name>` fallback only when collisions with Claude-native tools or MCP aliases occur.
- The initial MCP allowlist for v1 should cover representative safe/value-dense tools only: core Godmother read/search/move tools, trigger discovery/subscription helpers, and tunnel tools already supported by PizzaPi.
- Claude CLI schema limitations should be handled by skipping unsupported tools during registry construction and logging the reason.

---

## Chunk 1: Compatibility Registry and Provider Wiring

### Task 1: Add failing tests for Claude compatibility registry

**Files:**
- Create: `packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts`
- Reference: `packages/cli/src/extensions/claude-code-provider/types.ts`

- [ ] **Step 1: Write the failing test for core PizzaPi tool registration**

```ts
test("buildCompatRegistry includes core PizzaPi tools", () => {
  const registry = buildCompatRegistry({ mcpTools: [] });
  expect(registry.lookup("read")?.pizzaPiToolName).toBe("read");
  expect(registry.lookup("AskUserQuestion")?.kind).toBe("workflow");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts`
Expected: FAIL because `buildCompatRegistry` does not exist yet.

- [ ] **Step 3: Write the failing test for collision-safe Claude-facing names**

```ts
test("registry renames conflicting Claude-facing tool names without losing PizzaPi canonical names", () => {
  const registry = buildCompatRegistry({ mcpTools: [] });
  const entry = registry.findByPizzaPiName("read");
  expect(entry?.pizzaPiToolName).toBe("read");
  expect(entry?.claudeToolName).toBeTruthy();
});
```

- [ ] **Step 4: Run the test file again and verify both fail for the expected missing implementation reasons**

Run: `bun test packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts`
Expected: FAIL with missing import/function errors, not syntax errors.

### Task 2: Implement the compatibility registry

**Files:**
- Create: `packages/cli/src/extensions/claude-code-provider/compat-registry.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/types.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts`

- [ ] **Step 1: Add minimal types for compat entries and registry configuration**

Include types for:
- core PizzaPi tools
- workflow tools
- allowlisted MCP-backed tools
- Claude-facing vs canonical PizzaPi names

- [ ] **Step 2: Implement `buildCompatRegistry()` with core tool entries only**

Implement lookup helpers:
- `lookup(claudeToolName)`
- `findByPizzaPiName(pizzaPiToolName)`
- `listClaudeTools()`

- [ ] **Step 3: Add collision-safe name generation**

Rules:
- preserve canonical PizzaPi names in metadata
- generate unique Claude-facing names when needed
- keep naming deterministic for tests

- [ ] **Step 4: Run registry tests and make them pass**

Run: `bun test packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the chunk**

```bash
git add packages/cli/src/extensions/claude-code-provider/compat-registry.ts \
  packages/cli/src/extensions/claude-code-provider/compat-registry.test.ts \
  packages/cli/src/extensions/claude-code-provider/types.ts
git commit -m "feat: add Claude PizzaPi compatibility registry"
```

### Task 3: Wire the registry into Claude provider startup

**Files:**
- Modify: `packages/cli/src/extensions/claude-code-provider/extension.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/types.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/stream.test.ts`

- [ ] **Step 1: Write the failing test for provider wiring**

Add a test that asserts the Claude provider config passes:
- the built compatibility registry
- v1 MCP allowlist settings
- workflow adapter configuration (including question timeout)
- current session context used for bridge export/resume

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `bun test packages/cli/src/extensions/claude-code-provider/stream.test.ts`
Expected: FAIL because the provider does not yet pass compatibility config.

- [ ] **Step 3: Update `extension.ts` to construct and pass the registry/config**

Pass:
- active session context
- bridge persistence callbacks
- compat registry
- v1 MCP allowlist config

- [ ] **Step 4: Run the targeted provider tests**

Run: `bun test packages/cli/src/extensions/claude-code-provider/stream.test.ts`
Expected: PASS for updated assertions.

- [ ] **Step 5: Run typecheck after Chunk 1**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the wiring changes**

```bash
git add packages/cli/src/extensions/claude-code-provider/extension.ts \
  packages/cli/src/extensions/claude-code-provider/types.ts \
  packages/cli/src/extensions/claude-code-provider/stream.test.ts
git commit -m "feat: wire Claude provider compatibility registry"
```

---

## Chunk 2: MCP Compatibility Bridge

### Task 4: Add failing tests for allowlisted MCP exposure

**Files:**
- Create: `packages/cli/src/extensions/claude-code-provider/mcp-compat.test.ts`
- Reference: `packages/cli/src/extensions/mcp-bridge.ts`
- Reference: `packages/cli/src/extensions/mcp-extension.ts`

- [ ] **Step 1: Write the failing test for allowlist filtering**

```ts
test("buildMcpCompatTools only exposes allowlisted MCP tools", () => {
  const tools = buildMcpCompatTools({
    allowlist: ["mcp_godmother_search_ideas"],
    available: [
      { name: "mcp_godmother_search_ideas", description: "..." },
      { name: "mcp_jules_create_session", description: "..." },
    ],
  });
  expect(tools.map((t) => t.pizzaPiToolName)).toEqual(["mcp_godmother_search_ideas"]);
});
```

- [ ] **Step 2: Write the failing test for unsupported schema rejection**

```ts
test("buildMcpCompatTools skips MCP tools that cannot be normalized for Claude", () => {
  const tools = buildMcpCompatTools({ allowlist: ["bad_tool"], available: [makeUnsupportedTool()] });
  expect(tools).toEqual([]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/cli/src/extensions/claude-code-provider/mcp-compat.test.ts`
Expected: FAIL because the module does not exist yet.

### Task 5: Implement MCP compatibility wrapper

**Files:**
- Create: `packages/cli/src/extensions/claude-code-provider/mcp-compat.ts`
- Modify: `packages/cli/src/extensions/mcp-bridge.ts`
- Modify: `packages/cli/src/extensions/mcp-extension.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/mcp-compat.test.ts`
- Test: `packages/cli/src/extensions/mcp.test.ts`

- [ ] **Step 1: Add the minimal bridge helper accessors needed by Claude compat code**

Expose read-only access to:
- active bridge state
- available MCP tool metadata
- execution entry point needed for the allowlisted wrapper

- [ ] **Step 2: Add a focused failing/passing test for the new bridge accessor contract**

Run: `bun test packages/cli/src/extensions/mcp.test.ts`
Expected: FAIL before the accessor exists, PASS after implementing it.

- [ ] **Step 3: Implement `buildMcpCompatTools()` for allowlisted, schema-compatible tools only**

Return metadata containing:
- canonical PizzaPi tool name
- Claude-facing tool name
- normalized parameters schema
- execution callback metadata

- [ ] **Step 4: Implement result normalization from MCP execution to Claude tool_result payload + PizzaPi event metadata**

- [ ] **Step 5: Run targeted tests and make them pass**

Run:
- `bun test packages/cli/src/extensions/claude-code-provider/mcp-compat.test.ts`
- `bun test packages/cli/src/extensions/mcp.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck after Chunk 2**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the MCP compatibility chunk**

```bash
git add packages/cli/src/extensions/claude-code-provider/mcp-compat.ts \
  packages/cli/src/extensions/claude-code-provider/mcp-compat.test.ts \
  packages/cli/src/extensions/mcp-bridge.ts \
  packages/cli/src/extensions/mcp-extension.ts \
  packages/cli/src/extensions/mcp.test.ts
git commit -m "feat: add Claude MCP compatibility wrapper"
```

---

## Chunk 3: Workflow Adapter for Questions, Plans, Trigger Subscription, and Child Sessions

### Task 6: Add failing tests for workflow queueing and timeouts

**Files:**
- Create: `packages/cli/src/extensions/claude-code-provider/workflow-adapter.test.ts`
- Reference: `packages/cli/src/extensions/remote-ask-user.ts`
- Reference: `packages/cli/src/extensions/remote-plan-mode.ts`
- Reference: `packages/cli/src/extensions/trigger-client.ts`

- [ ] **Step 1: Write the failing test for AskUserQuestion timeout behavior**

```ts
test("workflow adapter returns a structured timeout result when AskUserQuestion has no answer", async () => {
  const adapter = createWorkflowAdapter(makeWorkflowDeps({ questionTimeoutMs: 1 }));
  const result = await adapter.handleAskUserQuestion(makeQuestionRequest());
  expect(result.status).toBe("timeout");
});
```

- [ ] **Step 2: Write the failing test for trigger queue ordering**

```ts
test("workflow adapter delivers steer before followUp at the next safe turn boundary", async () => {
  const adapter = createWorkflowAdapter(makeWorkflowDeps());
  adapter.enqueueTrigger(makeTrigger("steer", "t1"));
  adapter.enqueueTrigger(makeTrigger("followUp", "t2"));
  expect(adapter.flushQueuedEventsAtTurnBoundary().map((e) => e.id)).toEqual(["t1", "t2"]);
});
```

- [ ] **Step 3: Run the workflow test file to verify failure**

Run: `bun test packages/cli/src/extensions/claude-code-provider/workflow-adapter.test.ts`
Expected: FAIL because the adapter module does not exist yet.

### Task 7: Implement the workflow adapter

**Files:**
- Create: `packages/cli/src/extensions/claude-code-provider/workflow-adapter.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/types.ts`
- Modify: `packages/cli/src/extensions/trigger-client.ts`
- Modify: `packages/cli/src/extensions/remote-ask-user.ts`
- Modify: `packages/cli/src/extensions/remote-plan-mode.ts`
- Modify: `packages/cli/src/extensions/remote-trigger-response.ts`
- Modify: `packages/cli/src/extensions/remote.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/workflow-adapter.test.ts`
- Test: `packages/cli/src/extensions/remote-ask-user.test.ts`
- Test: `packages/cli/src/extensions/remote-plan-mode.test.ts`
- Test: `packages/cli/src/extensions/remote-trigger-response.test.ts`
- Test: `packages/cli/src/extensions/trigger-client.test.ts`

- [ ] **Step 1: Implement the minimal queue model and safe turn-boundary flush API**

Needed behaviors:
- queue `steer` and `followUp`
- flush only after Claude stream completion + tool reconciliation
- preserve deterministic ordering

- [ ] **Step 2: Implement AskUserQuestion and plan_mode wrappers with structured success/cancel/timeout results**

- [ ] **Step 3: Implement trigger-to-Claude injection payload formatting with preserved trigger IDs**

- [ ] **Step 4: Expose trigger discovery/subscription tools through the compatibility registry and workflow adapter**

Include support coverage for:
- `list_available_triggers`
- `subscribe_trigger`
- `unsubscribe_trigger`
- `update_trigger_subscription`
- `respond_to_trigger`

- [ ] **Step 5: Wire default child-session provider inheritance for Claude parents**

Default rule: child sessions inherit the Claude parent provider unless explicitly overridden.

- [ ] **Step 6: Reuse existing remote workflow helpers instead of duplicating protocol logic**

- [ ] **Step 7: Run the targeted workflow tests**

Run:
- `bun test packages/cli/src/extensions/claude-code-provider/workflow-adapter.test.ts`
- `bun test packages/cli/src/extensions/remote-ask-user.test.ts`
- `bun test packages/cli/src/extensions/remote-plan-mode.test.ts`
- `bun test packages/cli/src/extensions/remote-trigger-response.test.ts`
- `bun test packages/cli/src/extensions/trigger-client.test.ts`

Expected: PASS.

- [ ] **Step 8: Run typecheck after Chunk 3**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit the workflow chunk**

```bash
git add packages/cli/src/extensions/claude-code-provider/workflow-adapter.ts \
  packages/cli/src/extensions/claude-code-provider/workflow-adapter.test.ts \
  packages/cli/src/extensions/claude-code-provider/types.ts \
  packages/cli/src/extensions/trigger-client.ts \
  packages/cli/src/extensions/remote-ask-user.ts \
  packages/cli/src/extensions/remote-plan-mode.ts \
  packages/cli/src/extensions/remote-trigger-response.ts \
  packages/cli/src/extensions/remote.ts \
  packages/cli/src/extensions/remote-ask-user.test.ts \
  packages/cli/src/extensions/remote-plan-mode.test.ts \
  packages/cli/src/extensions/remote-trigger-response.test.ts \
  packages/cli/src/extensions/trigger-client.test.ts
git commit -m "feat: add Claude workflow compatibility adapter"
```

---

## Chunk 4: Stream Integration for Tool Routing and Runtime Events

### Task 8: Add failing stream-level tests for compat execution

**Files:**
- Modify: `packages/cli/src/extensions/claude-code-provider/stream.test.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`

- [ ] **Step 1: Add the failing stream test for PizzaPi-native tool event emission from Claude tool_use**

Test should verify:
- tool start/end events are emitted
- canonical PizzaPi tool names are preserved in UI-facing metadata
- final Claude result still arrives

- [ ] **Step 2: Add the failing stream test for tunnel tool exposure and execution metadata**

Test should verify `create_tunnel`, `list_tunnels`, and `close_tunnel` are exposed through compat mapping and preserve canonical PizzaPi naming in tool events.

- [ ] **Step 3: Run the targeted tests and verify failure**

Run: `bun test packages/cli/src/extensions/claude-code-provider/stream.test.ts`
Expected: FAIL for the new coverage only.

### Task 9: Integrate registry, MCP wrapper, and workflow adapter into the Claude stream

**Files:**
- Modify: `packages/cli/src/extensions/claude-code-provider/stream.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/session-bridge.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/extension.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/stream.test.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/session-bridge-thinking.test.ts`

- [ ] **Step 1: Route Claude tool_use blocks through the compatibility registry**

- [ ] **Step 2: Emit PizzaPi-native tool_execution lifecycle events around compat tool execution**

- [ ] **Step 3: Flush queued workflow events only at safe turn boundaries**

- [ ] **Step 4: Keep session export/resume continuation logic aligned with canonical PizzaPi transcript rules**

- [ ] **Step 5: Run the targeted Claude provider tests**

Run:
- `bun test packages/cli/src/extensions/claude-code-provider/stream.test.ts`
- `bun test packages/cli/src/extensions/claude-code-provider/session-bridge-thinking.test.ts`
- `bun test packages/cli/src/extensions/tunnel-tools.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck after Chunk 4**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the stream integration chunk**

```bash
git add packages/cli/src/extensions/claude-code-provider/stream.ts \
  packages/cli/src/extensions/claude-code-provider/stream.test.ts \
  packages/cli/src/extensions/claude-code-provider/session-bridge.ts \
  packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts \
  packages/cli/src/extensions/claude-code-provider/session-bridge-thinking.test.ts \
  packages/cli/src/extensions/claude-code-provider/extension.ts
git commit -m "feat: integrate Claude PizzaPi compatibility flow"
```

## Chunk 5: Continuity Hardening and Transcript Divergence Recovery

### Task 10: Add failing continuation and divergence-rebuild tests

**Files:**
- Modify: `packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/stream.test.ts`

- [ ] **Step 1: Add the failing session-bridge regression test for continuation after workflow/tool-result export**

Test should verify no duplicate prompt resend occurs after resumed continuation.

- [ ] **Step 2: Add the failing test for transcript divergence rebuild**

Test should verify that when exported Claude-side state fingerprint diverges from the canonical PizzaPi transcript, the bridge rebuilds instead of reusing stale state.

- [ ] **Step 3: Run the targeted tests and verify failure**

Run:
- `bun test packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`
- `bun test packages/cli/src/extensions/claude-code-provider/stream.test.ts`

Expected: FAIL for the new coverage only.

### Task 11: Implement continuity hardening and divergence rebuild behavior

**Files:**
- Modify: `packages/cli/src/extensions/claude-code-provider/session-bridge.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/stream.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`
- Test: `packages/cli/src/extensions/claude-code-provider/stream.test.ts`

- [ ] **Step 1: Implement minimal divergence detection and rebuild behavior**

- [ ] **Step 2: Reconcile continuation behavior for workflow pauses, tool results, and queued triggers**

- [ ] **Step 3: Run the targeted continuity tests**

Run:
- `bun test packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts`
- `bun test packages/cli/src/extensions/claude-code-provider/stream.test.ts`

Expected: PASS.

- [ ] **Step 4: Run typecheck after Chunk 5**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit the continuity chunk**

```bash
git add packages/cli/src/extensions/claude-code-provider/session-bridge.ts \
  packages/cli/src/extensions/claude-code-provider/session-bridge.test.ts \
  packages/cli/src/extensions/claude-code-provider/stream.ts \
  packages/cli/src/extensions/claude-code-provider/stream.test.ts
git commit -m "fix: harden Claude compatibility session continuity"
```

---

## Chunk 6: Observability, Sigils, Polish, and End-to-End Verification

### Task 12: Add observability, sigil propagation, and final verification

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-04-09-claude-pizzapi-compat-design.md`
- Modify if needed: provider docs/comments near changed code paths
- Modify: `packages/cli/src/extensions/claude-code-provider/stream.ts`
- Modify: `packages/cli/src/extensions/claude-code-provider/extension.ts`
- Modify if needed: `packages/cli/src/extensions/set-session-name.ts`

- [ ] **Step 1: Add debug logging/counters for unsupported tools, name mapping, trigger queueing, workflow waits, and rebuild decisions**

- [ ] **Step 2: Verify sigil discovery data is propagated into Claude compatibility context**

Add or update targeted assertions in provider tests if needed.

- [ ] **Step 3: Add an integration/smoke test for a representative Claude compat flow**

Suggested path: user prompt -> Claude tool_use -> PizzaPi tool lifecycle events -> workflow/trigger continuation -> final assistant response.

- [ ] **Step 4: Run the targeted Claude/MCP/workflow suites**

Run:
```bash
bun test packages/cli/src/extensions/claude-code-provider/*.test.ts \
  packages/cli/src/extensions/mcp.test.ts \
  packages/cli/src/extensions/remote-ask-user.test.ts \
  packages/cli/src/extensions/remote-plan-mode.test.ts \
  packages/cli/src/extensions/remote-trigger-response.test.ts \
  packages/cli/src/extensions/trigger-client.test.ts \
  packages/cli/src/extensions/tunnel-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Run any needed focused build/compile check**

Run: `bun run build`
Expected: PASS, or if too expensive during iteration, run at least once before handoff.

- [ ] **Step 7: Review git diff for drift or scope creep**

Run:
```bash
git diff --stat
git diff -- packages/cli/src/extensions/claude-code-provider \
  packages/cli/src/extensions/mcp-bridge.ts \
  packages/cli/src/extensions/mcp-extension.ts \
  packages/cli/src/extensions/remote-ask-user.ts \
  packages/cli/src/extensions/remote-plan-mode.ts \
  packages/cli/src/extensions/remote-trigger-response.ts \
  packages/cli/src/extensions/trigger-client.ts \
  packages/cli/src/extensions/tunnel-tools.ts \
  packages/cli/src/extensions/remote.ts
```

Expected: only planned files changed.

- [ ] **Step 8: Commit final cleanup/docs changes**

```bash
git add docs/superpowers/specs/2026-04-09-claude-pizzapi-compat-design.md \
  packages/cli/src/extensions/claude-code-provider \
  packages/cli/src/extensions/mcp-bridge.ts \
  packages/cli/src/extensions/mcp-extension.ts \
  packages/cli/src/extensions/remote-ask-user.ts \
  packages/cli/src/extensions/remote-plan-mode.ts \
  packages/cli/src/extensions/remote-trigger-response.ts \
  packages/cli/src/extensions/trigger-client.ts \
  packages/cli/src/extensions/tunnel-tools.ts \
  packages/cli/src/extensions/remote.ts
git commit -m "docs: finalize Claude PizzaPi compatibility implementation"
```

---

## Execution Notes

- Use TDD for each task: test first, verify fail, implement minimal code, verify pass.
- Keep PizzaPi transcript/runtime authoritative; do not let Claude-side transcript assumptions drive workflow semantics.
- Reuse existing remote workflow and MCP infrastructure instead of cloning behavior.
- Keep v1 MCP exposure allowlisted.
- Respect existing sandbox controls; compatibility code must not bypass safe-mode restrictions.
- If a spawned child session provider decision needs refinement, default to inheriting the parent provider unless explicitly overridden.

## Suggested Review Checkpoints

After each chunk:
- run the chunk’s targeted tests
- inspect the changed diff
- request a focused review on that chunk before proceeding

## Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-09-claude-pizzapi-compat.md`. Ready to execute?
