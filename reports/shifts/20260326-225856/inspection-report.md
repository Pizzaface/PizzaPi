# Health Inspection — 2026-03-27

**Shift:** 20260326-225856
**Inspector:** Health Inspector (invoked 12:15 EDT)
**Dishes Inspected:** 7 of 14 served (all open PRs)
**Inspector Models:** claude-sonnet-4-6, gemini-3.1-pro-preview (diverse from Codex cook pool)

---

## Overall Grade

**D** — Multiple violations. Critics were interrupted and largely unreliable this shift.

The session-delink incident at 00:35 prevented critic dispatch for 6 of 7 PRs. Only 1 critic completed (LGTM on PR #360). The inspector found a P1 on #360 that both the critic and the independent inspector missed. 5 of 7 PRs have P1-level issues that would have been caught by a functioning critic pass.

---

## Per-Dish Results

### PR #360: perf — slow UI load (dish 013)
- **Critic Verdict:** LGTM (1 critic completed)
- **Inspector Verdict:** CITATION (P2/P3 only per inspector)
- **Health Inspector Finding:** VIOLATION — inspector also missed the P1 CI failure
- **Findings:**
  - **P1 (Health Inspector, pre-inspection):** `routes/sessions.test.ts` uses top-level `mock.module("../sessions/store.js")` without proper isolation. On Linux CI (Bun same-worker), this pollutes the module registry for `pin.test.ts` and `runner-assoc-persist.test.ts`, causing them to import the mocked store. `mock.restore()` in `afterAll` runs after all files complete, not after one file. Both tests fail in CI. Confirmed by CI run 23630337456.
  - **P2:** `getAllSessionSummaries` (the central new Redis function, ~100 lines of non-trivial logic) has zero unit tests — two distinct code paths, boolean coercions, field ordering.
  - **P3:** Dead emptiness guard in `hmGet` path; `ui-load-investigation.md` committed to repo root; test misses positive-truthy cases; fragile `as unknown as` cast for `hmGet` detection.
- **Discrepancy:** Critic LGTM missed P1 CI failure. Independent inspector also missed it (incorrectly called it "zero pollution risk"). Health Inspector caught it via CI log analysis.
- **Action:** Fixer dispatched (session 8c45d710). PR #360 blocked from merge until CI passes.

---

### PR #362: feat — Godmother service panel (dish 016)
- **Critic Verdict:** None (session delink)
- **Inspector Verdict:** VIOLATION (P1 found; inspector labeled "CITATION" but that was incorrect given the P1)
- **Findings:**
  - **P1:** `dispose()` race orphans MCP subprocess. If `dispose()` fires while `clientPromise` is in-flight, the `.then()` callback still runs post-dispose and writes a new `McpClient` reference to `this.client`. No owner will ever call `.close()`. Each rapid reconnect during init leaks a child process.
  - **P2a:** `list_ideas` never forwards `limit` — the `slice(0, limit)` runs in-memory after fetching all records. Could pull thousands of items on large Godmother backlogs.
  - **P2b:** `search_ideas` silently drops the `topic` filter — topic is applied client-side after server has already truncated to `limit`. Users get fewer results than expected with no explanation.
  - **P3:** `sessionId` prop accepted but unused; `topicDrafts` map grows unbounded; `idea_move_status` handler untested; `DEFAULT_PROJECT` hardcoded to `"PizzaPi"`.
- **Discrepancy:** No critic. Inspector independently found P1 + 2 P2s.
- **Action:** Godmother ideas captured. Fixer to be dispatched for P1 + P2s.

---

### PR #363: feat — consistent error messaging (dish 009)
- **Critic Verdict:** None (session delink)
- **Inspector Verdict:** VIOLATION (2 P1s found; inspector labeled "CITATION" — incorrect)
- **Findings:**
  - **P1a:** Server diagnostic messages silently swallowed by generic fallback. "Session not found" → "Failed to load session." (wrong — implies transient error, will prompt retries for a permanent condition). "Session snapshot not available" also clobbered.
  - **P1b:** Test for `connect_error` covers a fabricated string `"connect_error: xhr poll error"` that doesn't match real socket.io format. Real socket.io delivers an `Error` object with `.message = "xhr poll error"` — no prefix. The production path falls through to context fallback, not the "Lost connection" message the test expects. Test gives false confidence.
  - **P2a:** Auth error copy "Sign in again and retry" — no sign-in action exists in viewer context. User must reload page.
  - **P2b:** Generic `>=500` handler preempts context-specific fallbacks for `runner_stop`/`runner_restart`.
  - **P3:** Structured logger replaced with `console.error`; test coverage gaps (6 of 14 decision paths covered).
- **Discrepancy:** No critic. Inspector found 2 P1s + 2 P2s independently.
- **Action:** Godmother ideas captured. Fixer to be dispatched.

---

### PR #364: fix — UI stability core (dishes 004+005+008)
- **Critic Verdict:** None (session delink)
- **Inspector Verdict:** CITATION
- **Findings:**
  - **P2a:** Exit code corrupted when fatal `uncaughtException` fires during SIGTERM drain window. Re-entrancy guard returns early discarding `exitCode=1` → drain completes with `process.exit(0)`. Error logged but process managers see clean exit.
  - **P2b:** No unit test for the tunnel timeout cancellation (the 2 added lines that ARE the fix).
  - **P3:** TDZ comment incomplete; ECONNRESET blanket-swallow reduces fault visibility; `useState` boilerplate volume for App.tsx session state.
- **Discrepancy:** No critic. All three fixes are logically correct. P2s are real but not blockers.
- **Action:** Godmother ideas captured. Low-priority fixer for P2s.

---

### PR #365: fix — chunk idempotency + React state hygiene (dishes 006+007)
- **Critic Verdict:** None (session delink)
- **Inspector Verdict:** VIOLATION (P1 found; inspector labeled "CITATION" — incorrect)
- **Findings:**
  - **P1:** Out-of-order chunk finalization silently skips `patchSessionCache` and `setActiveToolCalls`. When `readyToFinalize=true` but finalization is triggered by a non-final chunk (`isFinal=false`), `dedupedForSideEffects` is null and the side-effect block (`if (dedupedForSideEffects)`) is skipped. Session cache goes stale; in-flight tool detection lost after hydration. Tab-switching after chunked reconnect shows stale messages.
  - **P2a:** `dedupedForSideEffects` mutation from inside a `setMessages` functional updater violates React model — works empirically but relies on synchronous updater execution that React doesn't guarantee.
  - **P2b:** Cross-chunk dedup skipped in out-of-order case.
- **Discrepancy:** No critic. Server-side idempotency fix is clean; App.tsx integration path has P1.
- **Action:** Godmother ideas captured. Fixer to be dispatched for P1.

---

### PR #366: feat — Docker versioning + upgrade safety (dishes 001+002+017)
- **Critic Verdict:** None (session delink)
- **Inspector Verdict:** VIOLATION (2 P1s; inspector labeled "CITATION" — incorrect)
- **Findings:**
  - **P1a:** `depends_on: - ui` uses short form (`condition: service_started`). On any system where the UI container's `cp -a` copy takes more than a few ms (cold pull, slow volume I/O), the server starts serving before `index.html` exists. The healthcheck was written to prevent exactly this but only works with `condition: service_healthy`.
  - **P1b:** `packages/ui/.dockerignore` placed at wrong path — Docker never reads it (reads from build context root or `Dockerfile.dockerignore` companion). Root `.dockerignore` misses `packages/ui/dev-dist` and `packages/ui/coverage`. Author's intent not enforced.
  - **P2:** `UI_VERSION` guard duplicated verbatim in 3 files; dual mismatch notification paths conflict + clobber stale-clock; workflow missing `tsconfig.base.json` in path trigger.
  - **P3:** `nginx:alpine` not digest-pinned; named volume survives `down`; no ARM64 platform build.
- **Discrepancy:** No critic. Inspector found 2 P1s that make GHCR deployment unreliable in production.
- **Action:** Godmother ideas captured. Fixer to be dispatched.

---

### PR #367: perf — connection audit and quick wins (dish 015)
- **Critic Verdict:** None (session delink)
- **Inspector Verdict:** CITATION
- **Findings:**
  - **P2a:** `service_announce` dedup creates starvation window after runner crash/reconnect. `seedServiceAnnounceCache` on reconnect pre-populates cache; first post-reconnect announce looks like "no change" → broadcast skipped → viewers that joined during the offline gap never get service panels.
  - **P2b:** "Already connected" sidebar path now takes 1200ms (scheduled fallback) instead of immediate REST fetch. Every sidebar remount with live socket shows blank/stale session list for 1.2s.
  - **P3:** `isSameServiceAnnounce` is order-sensitive (false negatives harmless); no test for `scheduleResyncFallback`; `connection-audit.md` committed to repo root.
- **Discrepancy:** No critic. Inspector found 2 real P2s — the quick wins introduced subtle regressions.
- **Action:** Godmother ideas captured. Low-priority fixer for P2s.

---

## Critic Accuracy Summary

| Metric | Value |
|--------|-------|
| Dishes inspected | 7 |
| Critics that completed | 1 (PR #360) |
| Clean bills (critic confirmed) | 0 |
| Citations (critic missed minor) | 0 |
| Violations (critic missed serious) | 1 (PR #360 — critic + inspector both missed P1) |
| Critic accuracy rate | 0% (1/1 critic missed a P1) |
| Note | 6 of 7 dishes had NO critic due to session delink at 00:35 |

---

## Systemic Patterns

1. **Concurrency / lifecycle cleanup:** 3 of 5 violations involve race conditions or resource leak on dispose/reconnect (PR #362 MCP orphan, PR #365 out-of-order finalization, PR #366 depends_on race). Cooks are implementing the happy path correctly but missing the "what happens when the world moves during an async operation" cases.

2. **Test coverage gaps on new functions:** PRs #360, #362, #363 all shipped new non-trivial functions with incomplete test suites. AGENTS.md rule "all new code must include tests" is being applied to test files being present but not to coverage depth.

3. **Test quality issues:** PRs #360 and #363 both have tests that test the wrong thing (mock.module leak, fabricated socket.io format). Tests pass but don't validate production behavior.

4. **Configuration artifacts committed to repo root:** 3 PRs committed work files to root (`ui-load-investigation.md`, `connection-audit.md`, `packages/ui/.dockerignore` in wrong place). Codex cooks have a pattern of dropping scratch files in obvious locations.

5. **Codex verdict labeling:** All 4 Codex-authored violations were labeled CITATION by inspectors despite having P1 findings. Inspector model calibration issue — verdicts were corrected in this report.

---

## Recommendations

1. **Critic model must be different from cook model.** All Codex-cooked dishes had no critics (delink). If critics had run, they should have used Sonnet or Gemini — not Codex again.

2. **Concurrency checklist in cook template.** Add a section: "For each async operation, what happens if dispose/disconnect fires during it?" Cooks are missing this systematically.

3. **Test quality gates.** After a cook adds tests, the Ramsey review should specifically check: (a) does the new test file use `mock.module`? If so, is there isolation? (b) does the test use real input formats or fabricated strings?

4. **Repo root hygiene.** Add a pre-commit check or Ramsey rule: no `*.md` files at repo root except `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`. Investigation artifacts go in PR descriptions.

5. **Session delink handling.** The 00:35 delink that killed 8 child sessions also wiped out all critic dispatch. The Maître d' should re-dispatch critics after a delink recovery rather than skipping them entirely.

---

## Fixers Dispatched — All Complete ✅

| PR | Fix Commit | What was fixed |
|----|-----------|----------------|
| #360 | `be7cc96f` | Removed `mock.module()` store pollution — CI tests now pass |
| #362 | `d025ac0c` | MCP subprocess orphan on dispose race; `list_ideas` limit; `search_ideas` topic filter |
| #363 | `349a1748` | "Session not found" no longer swallowed by generic fallback; `connect_error` test uses real socket.io `Error` format |
| #365 | `4a13d18e` | Out-of-order chunk finalization now always runs `patchSessionCache` + `setActiveToolCalls`; uses `appendedForSideEffects` (not stale `messagesRef.current`) |
| #366 | `bbfb96a9` | `depends_on: service_healthy` for UI container; `.dockerignore` renamed to `Dockerfile.dockerignore` companion form |

**PRs ready for merge review:** #360, #362, #363, #364, #365, #366, #367
