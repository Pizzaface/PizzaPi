# Health Inspection — 2026-03-23

**Shift:** 20260322-230305
**Inspector:** Health Inspector (invoked 2026-03-23, GPT-5.4 reviewers)
**Dishes Inspected:** 5 of 7 served (2 skipped — trivial/no critic)

## Overall Grade

**D** — Multiple violations. Critics were unreliable this shift.

3 of 5 inspected dishes received VIOLATION verdicts (critic missed P1-level issues). The in-shift GPT-5.3 Codex critics gave LGTM to dishes with structural bugs, stale-by-design health models, and false-positive error classification. Only 1 dish received a clean bill.

Grading scale:
- **A** — All clean bills. Critics caught everything.
- **B** — Citations only (P2/P3 misses). Minor gaps.
- **C** — 1-2 violations (P0/P1 misses). Significant gaps.
- **D** — Multiple violations. Critics were unreliable.
- **F** — Condemned dishes found. Do NOT merge without review.

## Per-Dish Results

### Dish 001: React Error Boundaries (PR #247)
- **Critic Verdict:** LGTM (after 2 rounds + 2 fixers)
- **Inspector Verdict:** 🚨 VIOLATION
- **Findings:** P1 — Root error boundary mounted *inside* `App`, not around it in `main.ts`. Any crash in `App` render/init bypasses the boundary entirely, defeating the stated purpose of "crash resilience."
- **Discrepancy:** Critic went through 2 rounds focusing on `resetKeys` comparison logic but never questioned whether the boundary was at the right tree level. The structural placement bug — the most fundamental issue — was missed entirely.
- **Action:** Fixer needed — move `<ErrorBoundary>` to `main.ts` wrapping `<App />`

### Dish 002: Redis Health + Degraded Banner (PR #249)
- **Critic Verdict:** LGTM (with P1 captured for follow-up)
- **Inspector Verdict:** 🚨 VIOLATION
- **Findings:** P1 — `serverHealth.redis` and `serverHealth.socketio` are write-once at startup. No listeners flip them back on disconnect/reconnect. `/health` returns false-positive `"ok"` after post-start outage. The degraded banner never appears for runtime failures.
- **Discrepancy:** The shift report noted this as a follow-up idea (`wnLA2Za9`), but the critic still gave LGTM. A known-broken health model should not pass code review — it should block merge until the fix is in, or the PR scope should be clearly documented as "startup-only."
- **Action:** Fixer needed — wire Redis `error`/`reconnecting` and Socket.IO disconnect events to flip health flags

### Dish 003: STDIO MCP Sandbox (PR #250)
- **Critic Verdict:** LGTM
- **Inspector Verdict:** ✅ CLEAN BILL
- **Findings:** None. The sandbox env removal is an intentional policy alignment. Stdio MCP servers were already outside filesystem sandboxing; this makes network policy consistent.
- **Discrepancy:** None — critic was right.
- **Action:** None

### Dish 004: Security Headers (PR #246)
- **Critic Verdict:** LGTM
- **Inspector Verdict:** 📝 CITATION
- **Findings:** P2 — Missing `Content-Security-Policy` header on both normal and fallback 500 responses. The PR adds 5 hardening headers but omits the most important browser policy header for XSS protection.
- **Discrepancy:** Critic validated the 5 headers that were added but didn't flag the absence of CSP. This is a completeness gap, not a correctness bug.
- **Action:** godmother-captured — add CSP header as follow-up

### Dish 005: Accessible Button Names (PR #252)
- **Skipped** — No in-shift critic (marked trivial, 1-line change)

### Dish 006: .gitignore Cleanup (PR #248)
- **Skipped** — No in-shift critic (marked trivial)

### Dish 007: Usage Error Trigger (PR #251)
- **Critic Verdict:** LGTM
- **Inspector Verdict:** 🚨 VIOLATION
- **Findings:**
  - P1 — Latched error flag survives agent recovery: if agent hits a retryable error then succeeds, parent still gets `session_error` trigger (false positive)
  - P1 — `includes("rate")` substring check matches unrelated words like `"generate"`, causing misclassification of generic errors as usage-limit failures
  - P2 — False-negative: misses `RESOURCE_EXHAUSTED` and similar real quota wording
  - P3 — No test coverage for emission/classification path
- **Discrepancy:** Critic gave LGTM without catching any of these. The feature is both over-broad (fires on non-errors) and under-broad (misses real errors) — fundamentally unreliable.
- **Action:** Fixer needed — replace substring heuristic with structured error classification, clear latched state on recovery

## Critic Accuracy Summary

| Metric | Value |
|--------|-------|
| Dishes inspected | 5 |
| Clean bills (critic confirmed) | 1 (20%) |
| Citations (critic missed minor) | 1 (20%) |
| Violations (critic missed serious) | 3 (60%) |
| Condemned (should not merge) | 0 |
| **Critic accuracy rate** | **20%** |

## Systemic Patterns

1. **Structural/architectural issues are blind spots for GPT-5.3 Codex critics.** The error boundary placement (Dish 001) and health model staleness (Dish 002) are both architectural problems — the code *locally* looks correct, but the design is wrong. The critics focused on line-level correctness and missed the forest for the trees.

2. **"Known issue → LGTM" antipattern.** Dish 002's critic acknowledged the stale health model but still gave LGTM because a follow-up was captured. A known P1 bug should block merge, not be deferred.

3. **Substring heuristics in security-adjacent code go unquestioned.** Dish 007's `includes("rate")` is an obvious false-positive generator, but the critic didn't test mental examples against it.

4. **Test coverage gaps are consistently overlooked.** All 3 violations had inadequate test coverage. Critics validated the happy path but didn't ask "what tests would catch this breaking?"

## Recommendations

- **Shift critic model for architectural reviews.** GPT-5.3 Codex excels at line-level correctness but struggles with structural placement and design-level bugs. Consider using GPT-5.4 or Claude Opus for dishes involving component architecture or system design.
- **Add "Where is this mounted?" to error boundary review prompts.** React error boundary placement is a known gotcha — prompt templates should explicitly ask about tree-level positioning.
- **Block merge on known P1s.** If the critic identifies a P1 issue, the verdict should be ISSUES_FOUND, not LGTM-with-follow-up. Capture the follow-up AND block the merge.
- **Require classification tests for heuristic matchers.** Any code that uses substring/regex matching for error classification must include test cases for false positives and false negatives.
- **Add "what breaks this?" to critic templates.** Critics should be prompted to think adversarially: "Give me an input that makes this code do the wrong thing."
