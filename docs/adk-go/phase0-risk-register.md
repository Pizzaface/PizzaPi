# Phase 0 — Risk Register

Risks, uncertainties, and exit criteria for the Claude CLI wrapper prototype.

---

## Protocol Uncertainty

**Severity: HIGH → MEDIUM** (partially resolved)

- Claude CLI `stream-json` format is not formally documented by Anthropic
  (see [anthropics/claude-code#24596](https://github.com/anthropics/claude-code/issues/24596)).
- Event types and fields may change between Claude CLI versions without notice.
  There is no stability guarantee or versioned schema.
- ~~The `--input-format stream-json` bidirectional protocol is undocumented~~
  ([anthropics/claude-code#24594](https://github.com/anthropics/claude-code/issues/24594)).
  **RESOLVED:** Validated via community SDKs (Go, Elixir, Python) and
  third-party documentation. See `docs/adk-go/phase0-stdin-protocol.md`.
- Field names, nesting, and even the set of event types are inferred from
  observation, not specification.

**Mitigation:**
- Pin to a specific Claude CLI version for the prototype.
- Build the parser with unknown-event tolerance (`UnknownEvent` fallback).
- Capture and commit sample NDJSON outputs as regression fixtures.
- Re-validate event shapes on each Claude CLI upgrade.

---

## Tool Round-Trip Uncertainty

**Severity: HIGH → MEDIUM** (path identified)

- Claude CLI handles tool execution internally — the wrapper can only
  **observe** tool calls and results, not **intercept** them.
- Custom tools (PizzaPi's `plan_mode`, `AskUserQuestion`, `subagent`,
  `spawn_session`, `respond_to_trigger`, etc.) cannot be injected through the
  CLI's tool execution pipeline.
- **UPDATE:** The `--permission-prompt-tool stdio` flag enables a
  `control_request`/`control_response` protocol for tool approvals via stdin.
  This gives us approve/deny control but NOT tool interception.
  True custom tools require MCP server injection or direct API integration.
- The CLI's built-in tools (`bash`, `read`, `write`, `search`) are executed
  by the CLI process itself — the wrapper has no hook point.
- MCP tool calls may have a different event shape than built-in tool calls.

**Mitigation:**
- Phase 0 validates observation-only mode — confirm that tool_use and
  tool_result events contain enough data to render in the PizzaPi UI.
- Custom tools require either an API-direct approach or a future SDK
  integration. This is explicitly out of scope for Phase 0.
- Document which PizzaPi features are blocked by observation-only and which
  work fine (e.g., session viewing works, plan approval does not).

**Impact if unmitigated:**
This may force a hybrid architecture: CLI wrapper for sessions using only
built-in tools, plus direct Anthropic API for sessions requiring custom tools.

---

## Auth / Session Persistence Uncertainty

**Severity: MEDIUM**

- Claude CLI manages its own auth flow (OAuth, API keys via
  `ANTHROPIC_API_KEY`). PizzaPi cannot control or customize the auth flow.
- Session persistence uses Claude CLI's own format in `~/.claude/projects/`.
  This may conflict with PizzaPi's session management if both write to the
  same directory.
- `--resume` behavior under long interruptions (hours, days) is unknown —
  internal state (MCP connections, tool handles) may not restore cleanly.
- Multiple concurrent sessions may have filesystem contention in
  `~/.claude/`.

**Mitigation:**
- Test `--resume` reliability with various interruption durations.
- Plan for a session ID mapping layer: PizzaPi session ID ↔ Claude CLI
  session ID, so PizzaPi can track sessions even if Claude's internal IDs
  change or are recycled.
- Test concurrent session isolation — verify two Claude CLI processes don't
  corrupt each other's session state.

---

## ADK Coexistence Uncertainty

**Severity: LOW**

- The original epic assumes ADK Go for orchestration, but ADK Go is
  Gemini-centric and may not support Anthropic models natively.
- The Claude CLI wrapper is an **alternative** to ADK Go for Anthropic models.
- The two approaches may coexist (ADK Go for Gemini/OpenAI, CLI wrapper for
  Claude) or one may prove sufficient and the other be dropped.
- Maintaining two orchestration paths increases complexity and testing
  surface.

**Mitigation:**
- Phase 0 validates the CLI wrapper independently — no ADK Go dependency.
- ADK Go evaluation is deferred until Phase 0 results are in.
- Architecture decision (CLI-only, ADK-only, or hybrid) will be made after
  Phase 0 based on concrete capability gaps.

---

## Subprocess Lifecycle Risks

**Severity: MEDIUM**

- The Claude CLI may not handle `SIGTERM` gracefully — it could drop the
  final `result` event or leave orphaned child processes.
- Zombie processes: if the Go wrapper crashes without sending `SIGKILL`, the
  Claude CLI process may run indefinitely.
- Exit codes may not distinguish between success, user abort, auth failure,
  network error, and context overflow.
- The CLI's stderr output format is unstructured — error classification
  requires fragile string matching.

**Mitigation:**
- Implement a process reaper with PID tracking and timeout-based escalation
  (`SIGTERM` → wait → `SIGKILL`).
- Test and document all observed exit codes.
- Parse stderr into structured error categories with fallback to raw string.

---

## Prototype Exit Criteria

### Success Criteria

The prototype is considered **successful** if:

1. **Parser completeness** — Handles all observed NDJSON event types from
   sample Claude CLI output without crashes or silent data loss.
2. **Event mapping** — Adapter maps streaming text, tool use, tool result,
   and final result events to PizzaPi relay message shapes.
3. **Subprocess lifecycle** — Supports start, stop, resume, and error
   recovery with correct signal handling and resource cleanup.
4. **Planning signal** — Event stream is concrete enough to drive
   implementation planning for the full Go session host.
5. **Risk documentation** — All open risks are documented with explicit
   severity and mitigation paths (this document).

### Failure Criteria

The prototype is considered **failed** if:

1. **Insufficient data** — Claude CLI does not emit enough structured data
   for PizzaPi to render sessions (e.g., no tool call details, no token
   usage, no session ID).
2. **Interception required** — Tool interception is required for Phase 0 use
   cases and the CLI does not support it.
3. **Resume unreliable** — `--resume` reliability is too poor for production
   session management (>10% failure rate in testing).

### Decision Point

After Phase 0, the team decides:

- **Proceed to Phase 1** — CLI wrapper is viable, build the full Go session
  host on top of it.
- **Pivot to API-direct** — CLI wrapper is too limited, build directly
  against the Anthropic Messages API.
- **Hybrid** — Use CLI wrapper for simple sessions, API-direct for sessions
  requiring custom tools or advanced orchestration.

## Unblock Criteria for Follow-On Work

### idea:L5IOag95 — Phase 0 Prototype (ADK Go + CLI wrapper)

**Can move to `plan` when ALL of these are true:**
1. ✅ Wrapper parser is stable against sample Claude CLI output (validated via synthetic fixtures — 13 event types, 29 total tests passing)
2. ✅ Adapter covers streaming text, tool use, tool result, and terminal result → PizzaPi relay shapes
3. ✅ Subprocess lifecycle is explicit enough for a future Go host (start, stop, stderr, exit code)
4. ✅ Open risks are documented with explicit severity and mitigation paths
5. ⬜ **PENDING**: Live validation against actual `claude --output-format stream-json` output
6. ⬜ **PENDING**: Decision on custom tool injection architecture

**Recommendation:** Move to `plan` now. Items 5 and 6 can be resolved during implementation planning rather than blocking it.

### Ideas Intentionally Still Blocked

These must NOT be moved forward until L5IOag95 validates the full prototype:

| Idea ID | Summary | Blocker |
|---------|---------|---------|
| pfyKmDvB | Go daemon: supervisor + session manager | Needs proven session host model |
| PMzEWAAd | Port core coding tools to ADK Go | Needs proven tool/event integration |
| 9JXdBqZ5 | Build context compaction system | Needs proven session/event model |
| Brf0huSf | WebSocket relay client in Go | Needs daemon lifecycle defined |
| Jqjnnz6p | Multi-provider model abstraction | Needs prototype architecture decision |
