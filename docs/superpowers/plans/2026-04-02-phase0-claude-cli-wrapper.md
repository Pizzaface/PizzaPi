# Phase 0 Claude CLI Wrapper Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go-side Claude Code CLI process wrapper contract that proves PizzaPi can replace `pi-coding-agent` session execution with a typed subprocess/event bridge.

**Architecture:** Start at the existing PizzaPi seam where the Bun runner daemon spawns one worker per session and the remote extension serializes agent events into relay-friendly session events. The Phase 0 deliverable is not a full Go daemon; it is a contract-locked prototype plan centered on a Go wrapper that launches `claude`, parses NDJSON, normalizes lifecycle/tool/message events, and defines how those events map into PizzaPi’s current relay/UI protocol.

**Tech Stack:** Go, Claude Code CLI (`claude --output-format stream-json`), existing PizzaPi Socket.IO relay protocol, current React message model, Bun test harness artifacts as compatibility references.

---

## File structure / responsibility map

### Existing files to study and preserve as contracts
- `packages/cli/src/runner/session-spawner.ts` — current runner session process lifecycle, restart semantics, env propagation, session ownership
- `packages/cli/src/runner/daemon.ts` — runner↔relay contract and lifecycle expectations
- `packages/cli/src/extensions/remote/index.ts` — remote extension orchestration boundary
- `packages/cli/src/extensions/remote/lifecycle-handlers.ts` — current event emission/lifecycle semantics
- `packages/cli/src/extensions/remote/chunked-delivery.ts` — large-session transport constraints and snapshot/chunk delivery behavior
- `packages/protocol/src/runner.ts` — authoritative runner namespace protocol types
- `packages/ui/src/lib/message-helpers.ts` — UI normalization assumptions for relay messages
- `packages/ui/src/components/session-viewer/types.ts` — session-viewer message shapes that must remain renderable
- `packages/server/tests/harness/builders.ts` — protocol-compatible event fixtures useful for parity testing
- `packages/docs/src/content/docs/reference/protocol.mdx` — human-readable protocol reference to keep in sync with implementation choices

### New documents to create during Phase 0
- `docs/superpowers/plans/2026-04-02-phase0-claude-cli-wrapper.md` — this execution plan
- `docs/adk-go/phase0-wrapper-contract.md` — wrapper contract: process lifecycle, event schema, relay mapping, failure semantics
- `docs/adk-go/phase0-event-mapping.md` — side-by-side table mapping Claude NDJSON → PizzaPi relay/UI events
- `docs/adk-go/phase0-risk-register.md` — unresolved prototype risks, explicit non-goals, and unblock conditions for follow-on work

### Optional prototype workspace (only after design/contract is approved)
- `experimental/adk-go/claude-wrapper/` — isolated Go prototype package
- `experimental/adk-go/claude-wrapper/main.go` — manual runner for wrapper spike
- `experimental/adk-go/claude-wrapper/events.go` — typed Claude NDJSON event structs
- `experimental/adk-go/claude-wrapper/parser.go` — line scanner + decoder
- `experimental/adk-go/claude-wrapper/adapter.go` — PizzaPi event normalization adapter
- `experimental/adk-go/claude-wrapper/parser_test.go` — parser fixtures/tests
- `experimental/adk-go/claude-wrapper/adapter_test.go` — event mapping tests

---

## Chunk 1: Lock the compatibility contract

### Task 1: Capture the current runner/worker lifecycle as a migration contract

**Files:**
- Modify: `docs/adk-go/phase0-wrapper-contract.md`
- Reference: `packages/cli/src/runner/session-spawner.ts`
- Reference: `packages/cli/src/runner/daemon.ts`
- Reference: `packages/protocol/src/runner.ts`

- [ ] **Step 1: Create the contract doc skeleton**

Create `docs/adk-go/phase0-wrapper-contract.md` with sections:
- Purpose / non-goals
- Current Bun runner lifecycle
- Required Go wrapper lifecycle semantics
- Session ownership / restart / kill semantics
- Environment/config inputs
- Open questions

- [ ] **Step 2: Record current lifecycle facts from the code**

Document these concrete facts from the existing implementation:
- daemon spawns one session worker process per session
- session env propagation uses `PIZZAPI_RELAY_URL`, `PIZZAPI_API_KEY`, `PIZZAPI_SESSION_ID`, cwd/model/prompt env vars
- restart-in-place uses exit code `43` with pre-restart IPC signaling
- runner emits `session_ready`, `session_error`, `session_killed`, and `runner_session_event`
- relay may re-adopt existing sessions after reconnect

- [ ] **Step 3: Specify the Go wrapper equivalence target**

Write the explicit equivalence contract:
- one Claude subprocess per logical agent session in Phase 0
- typed event channel exposed to a future Go session host
- graceful stop, forced kill, resume, and parser-failure semantics
- distinction between wrapper process lifecycle and future daemon lifecycle

- [ ] **Step 4: Commit the documentation chunk**

Run:
```bash
git add docs/adk-go/phase0-wrapper-contract.md docs/superpowers/plans/2026-04-02-phase0-claude-cli-wrapper.md
git commit -m "docs: capture phase0 wrapper lifecycle contract"
```

### Task 2: Freeze the current relay/UI message contract

**Files:**
- Modify: `docs/adk-go/phase0-event-mapping.md`
- Reference: `packages/ui/src/lib/message-helpers.ts`
- Reference: `packages/ui/src/components/session-viewer/types.ts`
- Reference: `packages/server/tests/harness/builders.ts`
- Reference: `packages/docs/src/content/docs/reference/protocol.mdx`

- [ ] **Step 1: Write the current message assumptions table**

Document the PizzaPi-facing message assumptions already visible in code:
- relay messages are normalized by `role`
- tool results use `tool_result`/`toolresult` → `toolResult`
- UI keys depend on `toolCallId`, `id`, and `timestamp`
- compaction summaries and structured `details` must survive normalization
- partial streaming messages are represented by `isStreamingPartial`

- [ ] **Step 2: Derive minimum viable relay event set for Phase 0**

Create a table with columns:
- Claude NDJSON event type
- Parsed Go struct
- Adapter output event(s)
- Relay/UI consumer path
- Notes / ambiguities

Include at least:
- `system`
- assistant text/content deltas
- `tool_use`
- `tool_result`
- final `result`
- stderr/error conditions

- [ ] **Step 3: Mark unsupported or custom-only events explicitly**

Call out that the wrapper does **not** solve yet:
- compaction
n- trigger delivery
- plan mode
- service metadata
- follow-up/steering queues

Define what must be stubbed vs deferred.

- [ ] **Step 4: Commit the event-mapping chunk**

Run:
```bash
git add docs/adk-go/phase0-event-mapping.md packages/docs/src/content/docs/reference/protocol.mdx
git commit -m "docs: define phase0 claude event mapping"
```

---

## Chunk 2: Validate the Claude CLI subprocess contract

### Task 3: Build a typed NDJSON event catalog before coding the prototype

**Files:**
- Modify: `docs/adk-go/phase0-wrapper-contract.md`
- Create: `docs/adk-go/phase0-risk-register.md`

- [ ] **Step 1: Enumerate expected Claude stream-json event shapes**

In the contract doc, define tentative Go structs for:
- system/session metadata
- assistant content block updates
- tool call blocks
- tool result blocks
- terminal result summary
- recoverable parser errors / unknown events

Keep the structs illustrative and narrow: fields only if they are needed by PizzaPi.

- [ ] **Step 2: Write validation questions the prototype must answer**

Add a checklist such as:
- does `claude --output-format stream-json` emit stable event discriminators?
- can we distinguish partial vs final assistant output?
- can tool calls be intercepted or only observed?
- does `--resume` preserve enough session identity for PizzaPi?
- what appears on stdout vs stderr during failures?

- [ ] **Step 3: Create a risk register**

Create `docs/adk-go/phase0-risk-register.md` with sections:
- protocol uncertainty
- tool round-trip uncertainty
- auth/session persistence uncertainty
- ADK coexistence uncertainty
- prototype exit criteria

- [ ] **Step 4: Commit the risk-analysis chunk**

Run:
```bash
git add docs/adk-go/phase0-wrapper-contract.md docs/adk-go/phase0-risk-register.md
git commit -m "docs: capture phase0 wrapper risks and validation questions"
```

### Task 4: Only then build the isolated Go spike

**Files:**
- Create: `experimental/adk-go/claude-wrapper/main.go`
- Create: `experimental/adk-go/claude-wrapper/events.go`
- Create: `experimental/adk-go/claude-wrapper/parser.go`
- Create: `experimental/adk-go/claude-wrapper/parser_test.go`

- [ ] **Step 1: Write the failing parser test first**

Create `parser_test.go` with table-driven tests for NDJSON lines:
- valid `system` event
- valid assistant text event
- valid `tool_use`
- valid `tool_result`
- unknown event type is preserved as `UnknownEvent`
- malformed line returns structured parse error with source line

- [ ] **Step 2: Run the parser tests and confirm failure**

Run:
```bash
cd experimental/adk-go/claude-wrapper && go test ./...
```
Expected: FAIL because parser/types do not exist yet.

- [ ] **Step 3: Implement minimal typed event structs and decoder**

Implement:
- scanner over stdout lines
- JSON decode per line
- discriminator switch by type
- fallback unknown-event wrapper
- parse error type that preserves raw input and decode failure

- [ ] **Step 4: Run tests until green**

Run:
```bash
cd experimental/adk-go/claude-wrapper && go test ./...
```
Expected: PASS.

- [ ] **Step 5: Commit the parser spike**

Run:
```bash
git add experimental/adk-go/claude-wrapper
git commit -m "feat: add claude ndjson parser spike"
```

---

## Chunk 3: Prove PizzaPi event compatibility

### Task 5: Build the adapter from parsed Claude events to PizzaPi-style relay events

**Files:**
- Create: `experimental/adk-go/claude-wrapper/adapter.go`
- Create: `experimental/adk-go/claude-wrapper/adapter_test.go`
- Reference: `packages/server/tests/harness/builders.ts`
- Reference: `packages/ui/src/lib/message-helpers.ts`

- [ ] **Step 1: Write the failing adapter tests**

Cover at least:
- assistant text → `message_update`-compatible output
- tool call → tool message with stable `toolCallId`
- tool result → `tool_result_message`-compatible output
- final result → summary/terminal event record
- partial text updates preserve ordering and dedup expectations

- [ ] **Step 2: Run adapter tests and confirm failure**

Run:
```bash
cd experimental/adk-go/claude-wrapper && go test ./...
```
Expected: FAIL because adapter is not implemented.

- [ ] **Step 3: Implement the minimal adapter**

Implement a narrow mapping layer that emits JSON shapes mirroring the current relay contracts closely enough to be consumed by:
- `packages/ui/src/lib/message-helpers.ts`
- the server harness builders/tests
- future `runner_session_event` forwarding

- [ ] **Step 4: Re-run tests and inspect fixture output manually**

Run:
```bash
cd experimental/adk-go/claude-wrapper && go test ./...
```
Then optionally run a small local example to print adapted events for manual inspection.

- [ ] **Step 5: Commit the adapter spike**

Run:
```bash
git add experimental/adk-go/claude-wrapper
git commit -m "feat: add pizzapi relay adapter for claude wrapper"
```

### Task 6: Validate subprocess lifecycle semantics

**Files:**
- Modify: `experimental/adk-go/claude-wrapper/main.go`
- Create: `experimental/adk-go/claude-wrapper/main_test.go`

- [ ] **Step 1: Write lifecycle-focused tests around command construction**

Cover:
- correct `claude` argv construction
- working directory propagation
- env pass-through policy
- cancellation/timeout behavior via `context.Context`
- stdout/stderr separation

- [ ] **Step 2: Run tests and confirm failure**

Run:
```bash
cd experimental/adk-go/claude-wrapper && go test ./...
```
Expected: FAIL because lifecycle helpers are not implemented.

- [ ] **Step 3: Implement minimal command builder and process runner**

Implement only what is needed for Phase 0:
- command builder struct/options
- process start/stop wrapper
- stdout parser hookup
- stderr collector/log callback

- [ ] **Step 4: Re-run tests**

Run:
```bash
cd experimental/adk-go/claude-wrapper && go test ./...
```
Expected: PASS.

- [ ] **Step 5: Commit the lifecycle spike**

Run:
```bash
git add experimental/adk-go/claude-wrapper
git commit -m "feat: add claude wrapper lifecycle spike"
```

---

## Chunk 4: Gate the follow-on epic work

### Task 7: Produce the unblock memo for [[idea:L5IOag95]]

**Files:**
- Modify: `docs/adk-go/phase0-risk-register.md`
- Modify: `docs/adk-go/phase0-wrapper-contract.md`

- [ ] **Step 1: Add a prototype verdict section**

At the end of the prototype work, write a verdict with explicit answers:
- viable / not yet viable
- what worked
- what failed or remains unknown
- whether event fidelity is sufficient to justify Phase 0 continuation

- [ ] **Step 2: Define unblock criteria for [[idea:L5IOag95]]**

Record that [[idea:L5IOag95]] can move forward only if:
- wrapper parser is stable against sample outputs
- adapter covers streaming text, tool use, tool result, and terminal result
- subprocess lifecycle is explicit enough for a future Go host
- open risks are understood and bounded

- [ ] **Step 3: List downstream ideas still intentionally blocked**

Explicitly keep blocked after this work unless separately approved:
- [[idea:pfyKmDvB]]
- [[idea:PMzEWAAd]]
- [[idea:9JXdBqZ5]]
- [[idea:Brf0huSf]]
- [[idea:Jqjnnz6p]]

- [ ] **Step 4: Commit the unblock memo**

Run:
```bash
git add docs/adk-go/phase0-risk-register.md docs/adk-go/phase0-wrapper-contract.md
git commit -m "docs: record phase0 prototype verdict and follow-on gate"
```

### Task 8: Final verification before claiming Phase 0 foundation is ready

**Files:**
- Verify only

- [ ] **Step 1: Run document and prototype checks**

Run:
```bash
go test ./experimental/adk-go/claude-wrapper/...
bun run typecheck
```
Expected: both exit 0.

- [ ] **Step 2: Review git diff for scope control**

Run:
```bash
git diff --stat origin/main...HEAD
git status --short
```
Expected: only docs + isolated experimental prototype files relevant to Phase 0.

- [ ] **Step 3: Update Godmother state**

- Keep [[idea:Z7aIzmdN]] in `execute` while implementation is active.
- Move [[idea:Z7aIzmdN]] to `completed` only when the wrapper contract + spike + verification are done.
- Attempt to advance [[idea:L5IOag95]] only after the blocker is genuinely resolved.

- [ ] **Step 4: Push branch and hand off**

Run:
```bash
git pull --rebase
git push -u origin feat/adk-phase0-orchestration
git status
```
Expected: branch is pushed and status reports up to date.

---

## Notes for orchestration

- Start with documentation/contracts because the epic’s blocker graph shows the architecture is not yet frozen enough for broad implementation.
- Keep all prototype work isolated under `experimental/adk-go/` until the event and lifecycle contracts are validated.
- Do **not** start the Go daemon, relay client, compaction, or tool-port tickets during this wave.
- The only immediate follow-on to unlock is [[idea:L5IOag95]].

Plan complete and saved to `docs/superpowers/plans/2026-04-02-phase0-claude-cli-wrapper.md`. Ready to execute?