# Dish 004: Fix Stale Test Descriptions in remote-payload-cap.test.ts

- **Cook Type:** sonnet
- **Complexity:** S
- **Priority:** P3
- **Godmother ID:** TFHUdgx2
- **Dependencies:** none
- **Files:** packages/cli/src/extensions/remote-payload-cap.test.ts
- **Verification:** bun test packages/cli/src/extensions/remote-payload-cap.test.ts
- **Status:** queued
- **Confidence Band:** A
- **dispatchPriority:** high

## Task Description

After PR #257 reduced buffer sizes in `packages/cli/src/extensions/remote/chunked-delivery.ts`, the actual constants are now:
- `CHUNK_THRESHOLD = 5 * 1024 * 1024` (5 MB) — was 10 MB
- `CHUNK_BYTE_LIMIT = 6 * 1024 * 1024` (6 MB) — was 8 MB
- `MAX_MESSAGE_SIZE = 5 * 1024 * 1024` (5 MB) — was 50 MB

But `packages/cli/src/extensions/remote-payload-cap.test.ts` still has descriptions referencing the OLD values:

1. **Line 80:** `test("returns true for messages exceeding 10 MB threshold", () => {`
   → Should be: `test("returns true for messages exceeding 5 MB threshold", () => {`

2. **Line 81 (comment):** `// Each message ~10 KB, 2000 messages ≈ 20 MB > 10 MB threshold`
   → Should be: `// Each message ~10 KB, 2000 messages ≈ 20 MB > 5 MB threshold`

3. **Line 106 (comment):** `// 10 messages each ~2 MB — byte limit is 8 MB, so should get ~3 chunks`
   → Should be: `// 10 messages each ~2 MB — byte limit is 6 MB, so should get ~3 chunks` (or adjust to be accurate — 10 × 2MB = 20MB with 6MB limit gives ~4 chunks, not 3)

4. **Line 156:** `test("truncates messages exceeding 50 MB", () => {`
   → Should be: `test("truncates messages exceeding 5 MB cap", () => {` (MAX_MESSAGE_SIZE is 5 MB)

5. **Line 157 (if present):** `const hugeContent = "x".repeat(55_000_000); // ~55 MB` — content is still valid (55MB > 5MB cap), but could note "~55 MB, well above the 5 MB cap"

Also check line 67: `// One message > 10 MB threshold` → should be `// One message > 5 MB threshold`

**Steps:**
1. Branch: `git checkout -b fix/stale-test-descriptions-payload-cap`
2. Read `packages/cli/src/extensions/remote-payload-cap.test.ts` fully to see all stale descriptions
3. Read `packages/cli/src/extensions/remote/chunked-delivery.ts` to confirm current constants
4. Update all test descriptions and comments to match current constants
5. For line 106: verify the math — with 6MB byte limit and 10 messages of ~2MB each, compute how many chunks are expected, and fix the description to be accurate
6. Run: `bun test packages/cli/src/extensions/remote-payload-cap.test.ts` — must pass
7. Run: `bun run typecheck` — must pass  
8. Commit: `chore(cli): update stale test descriptions in remote-payload-cap.test.ts to reflect 5/6 MB constants`
9. Push and open a PR

## Notes
- Tests still PASS with current code (assertions use correct runtime values). This is purely a description accuracy fix.
- Do NOT change any assertion values or test logic — only update string descriptions and comments.
- The test file imports are at packages/cli/src/extensions/remote-payload-cap.test.ts but the implementation being tested is at packages/cli/src/extensions/remote/chunked-delivery.ts

## Acceptance Criteria
- All test descriptions and inline comments reference the correct current constants (5MB threshold, 6MB byte limit, 5MB max message size)
- Tests still pass
- No assertion values changed — only string literals and comments

## Health Inspection — 2026-03-25T11:46Z
- **Inspector Model:** claude-sonnet-4-6 (Anthropic)
- **Verdict:** CITATION
- **Findings:** P3 — `remote-payload-cap.test.ts:118`: comment updated from 8MB→6MB but `≤4 messages` per-chunk ceiling not corrected to `≤3`. With CHUNK_BYTE_LIMIT=6MB and ~2MB messages: floor(6/2)=3, not 4. Test still passes (actual 3 ≤ 4) but comment is misleading.
- **Critic Missed:** This math discrepancy (derived ceiling not re-computed after constant change).
