# Dish 002: Fix Fragile `usage` Assertion in search.test.ts

- **Cook Type:** sonnet
- **Complexity:** S
- **Priority:** P2
- **Godmother ID:** MCBL0VIN
- **Dependencies:** none
- **Files:** packages/tools/src/search.test.ts
- **Verification:** bun test packages/tools
- **Status:** queued
- **Confidence Band:** A
- **dispatchPriority:** high

## Task Description

In `packages/tools/src/search.test.ts` at line 250, there is a fragile test assertion:

```ts
expect(text.toLowerCase()).not.toContain("usage");
```

This assertion is meant to ensure that `find --help` output is NOT returned by the search tool when the user passes `--help` as a file path. However, this assertion will false-fail if:
- The current working directory path contains the word "usage" (e.g., a worktree named `nightshift/dish-007-usage-error-trigger`)
- Any system path component contains "usage"

**Fix:** Replace the broad `.not.toContain("usage")` with a more precise pattern that specifically targets help/usage output strings, not arbitrary path occurrences.

Look at the test context (lines ~240-260):
```ts
// Must NOT contain help/usage output from find
expect(text.toLowerCase()).not.toContain("usage");
// Should be either "No matches found" or "Search failed: ..." (path doesn't exist)
expect(text === "No matches found" || text.startsWith("Search failed:")).toBe(true);
```

Note: The assertion on the next line (`expect(text === "No matches found" || text.startsWith("Search failed:")).toBe(true)`) already covers the intent precisely! The `.not.toContain("usage")` check is redundant AND fragile.

**Fix options (in order of preference):**
1. **Remove the fragile line entirely** — the subsequent assertion already verifies the expected output precisely. The `.not.toContain("usage")` check adds no value and only creates false failures.
2. **Replace with `.not.toContain("usage:")` or `.not.toContain("usage\n")`** — if preserving the check is desired, make it specific to `find --help` output patterns.

Preferred fix: **Remove line 250** (`expect(text.toLowerCase()).not.toContain("usage")`). The test on line 252 already covers the same intent.

**Steps:**
1. Branch: `git checkout -b fix/search-test-fragile-usage-assertion`
2. Read `packages/tools/src/search.test.ts` lines 240-260 to confirm context
3. Remove or narrow the fragile assertion
4. Run: `bun test packages/tools` — must pass
5. Commit: `fix(tools): remove fragile not.toContain("usage") assertion in search.test.ts`
6. Push and open a PR

## Acceptance Criteria
- The fragile `.not.toContain("usage")` assertion is removed or narrowed to match only help text patterns
- `bun test packages/tools` passes
- The test still correctly validates that `find --help` output is not returned

## Health Inspection — 2026-03-25T11:46Z
- **Inspector Model:** claude-sonnet-4-6 (Anthropic)
- **Verdict:** CLEAN_BILL
- **Findings:** None
- **Critic Missed:** Nothing — critic verdict confirmed.
