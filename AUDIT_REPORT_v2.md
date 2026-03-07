# PizzaPi Clean Code Audit Report (v2 - Corrected)

**Generated:** March 7, 2026  
**Reviewed:** March 7, 2026  
**Status:** Corrected based on manual verification

---

## Executive Summary

This is the corrected audit report following manual verification of the original 6-session parallel audit. Several findings were overstated, partially true, or already fixed.

### Finding Classification

| Status | Count | Description |
|--------|-------|-------------|
| ✅ Verified | 12 | Confirmed issues requiring action |
| ⚠️ Partially True | 5 | Real issues but overstated severity/scope |
| ❌ False Positive | 3 | Already fixed or incorrect |

---

## ✅ VERIFIED ISSUES

### Security (Phase 1)

#### S1. Dependency Vulnerabilities [CRITICAL]
**Status:** ✅ Verified  
**Evidence:** `bun audit` reports 22 vulnerabilities (1 critical, 16 high)  
**Action:** Update dependencies, coordinate upstream for transitives

#### S2. Command Injection in git_diff [CRITICAL]
**Status:** ✅ Verified  
**Location:** `packages/cli/src/runner/daemon.ts:1090`  
**Issue:** Shell string interpolation with user-controlled `filePath`
```typescript
const { stdout: diff } = await execAsync(`git ${args.join(" ")}`, { cwd });
```
**Action:** Replace with `spawn()` using array arguments

#### S3. Rate Limiting Gaps [MEDIUM]
**Status:** ✅ Verified  
**Missing on:** `/api/chat`, `/api/runners/spawn`, WebSocket connections  
**Action:** Add targeted rate limits

#### S4. Request Body Validation [MEDIUM]
**Status:** ✅ Verified  
**Location:** `packages/server/src/routes/runners.ts`  
**Pattern:** `let body: any = {}` repeated 11 times  
**Action:** Add Zod schemas for runtime validation

#### S5. Missing Security Headers [LOW]
**Status:** ✅ Verified (needs check)  
**Missing:** CSP, HSTS  
**Action:** Add after verifying dev/proxy behavior

### Error Handling (Phase 2)

#### E1. No React Error Boundaries [CRITICAL]
**Status:** ✅ Verified  
**Evidence:** Zero `componentDidCatch` or error boundary implementations in `packages/ui/`  
**Action:** Add boundaries around App root, SessionViewer, FileExplorer, tool renderers

#### E2. Empty Catch Blocks [HIGH]
**Status:** ⚠️ Partially True (43, not 90+)  
**Evidence:** Literal `catch {}` search returns 43 occurrences  
**Action:** Audit and classify each; fix swallowed errors

#### E3. Fire-and-Forget Fetches [HIGH]
**Status:** ✅ Verified  
**Locations:** 8+ `void fetch(...)` calls in UI code  
**Action:** Replace with shared helper that handles timeout, non-2xx, user feedback

#### E4. Missing Unhandled Rejection Handlers [HIGH]
**Status:** ✅ Verified  
**Evidence:** No `process.on("unhandledRejection")` in CLI/server entry points  
**Action:** Add global handlers with logging and graceful shutdown

#### E5. Missing Network Timeouts [MEDIUM]
**Status:** ✅ Verified  
**Locations:** MCP client, spawn session fetch, usage fetching  
**Action:** Add AbortController with timeout for all network operations

### Performance (Phase 3)

#### P1. Terminal Buffer Unbounded Growth [MEDIUM]
**Status:** ⚠️ Partially True  
**Location:** `packages/server/src/ws/sio-registry.ts`  
**Reality:** Buffers have cleanup, but unbounded while waiting for viewer  
**Action:** Add explicit caps/max-size guardrails

#### P2. Attachment Retention Under Abuse [LOW]
**Status:** ⚠️ Partially True  
**Location:** `packages/server/src/attachments/store.ts`  
**Reality:** TTL + sweep exists, question is abuse scenarios  
**Action:** Consider max-count/max-bytes guardrails

#### P3. Missing Database Indexes [NEEDS MEASUREMENT]
**Status:** ⚠️ Needs Verification  
**Issue:** Queries filter by `isPinned` but no dedicated index  
**Action:** Benchmark query, add index only if plan supports it

#### P4. Sync File Operations in CLI [LOW]
**Status:** ⚠️ Partially True  
**Locations:** `skills.ts`, `config.ts`  
**Reality:** Some are startup-only (acceptable), some are hot paths  
**Action:** Convert hot-path sync I/O to async

### Type Safety (Phase 4)

#### T1. Pervasive `any` Usage [MEDIUM]
**Status:** ✅ Verified  
**Evidence:** ~55 explicit `: any`, ~100 `as any`  
**Priority Files:**
- `cli/extensions/mcp.ts` (18 total)
- `server/routes/runners.ts` (21 total)
- `ui/src/App.tsx` (25 total)
- `cli/extensions/remote.ts` (21 total)

**Action:** Phase 4, prioritize risky surfaces first

### Dead Code (Phase 4)

#### D1. Unused Dependencies [VERIFIED]
**Status:** ✅ Verified (partial)
- `@aws-sdk/client-s3` in server — Never imported ✅
- `@tanstack/react-virtual` in ui — Never imported ✅
- `socket.io-client` in server — Only in spike/, depends on spike cleanup

**Action:** Remove confirmed unused deps

#### D2. Orphan Files [NEEDS IMPORT SCAN]
**Status:** ⚠️ Needs Verification  
**Candidates:**
- `packages/server/spike/` — Entire directory is prototype code
- `packages/ui/src/lib/relay.ts`
- `packages/ui/src/lib/remote-exec.ts`
- `packages/ui/src/components/ai-elements/plan.tsx`
- `packages/ui/src/components/file-explorer/helpers.ts`

**Action:** Confirm via import scan, then delete/relocate

### Architecture (Phase 5)

#### A1. God Files [TRUE BUT NOT URGENT]
**Status:** ✅ Verified  
**Files:**
- `ui/src/App.tsx` — 3,290 lines
- `cli/extensions/remote.ts` — 2,041 lines
- `ui/src/components/SessionViewer.tsx` — 1,832 lines

**Action:** Phase 5 after tests/guardrails in place

#### A2. Test Coverage Gaps [DIRECTIONALLY TRUE]
**Status:** ⚠️ Numbers Suspect  
**Reality:** UI has 8 test files, not 0%  
**Action:** Rebaseline in Phase 0, expand critical tests in Phase 5

---

## ❌ FALSE POSITIVES / ALREADY FIXED

#### F1. Migration Failures Not Fatal
**Status:** ❌ Already Fixed  
**Location:** `packages/server/src/migrations.ts`  
**Evidence:** Code already does `process.exit(1)` on migration failure  
**Action:** Close with regression test

#### F2. Pending Deltas Never Cleared
**Status:** ❌ False Positive  
**Location:** `packages/ui/src/App.tsx:872`  
**Evidence:** `pendingDeltaRef` is cleared in `cancelPendingDeltas`, RAF flush, agent-end reset  
**Action:** Close, optionally add test/comment

#### F3. 90+ Empty Catch Blocks
**Status:** ❌ Overstated  
**Reality:** 43 literal `catch {}` blocks, not 90+  
**Action:** Reclassified under E2 with correct count

---

## Remediation Plan

### Phase 0: Audit Verification (1-2 days)
- Reproduce exact counts (`bun audit`, catch blocks, unused deps)
- Confirm orphan files via import scan
- Query plan review for `isPinned`
- Bundle size baseline
- Create discrete tickets per finding

### Phase 1: Security & Request Hardening (3-5 days)
- S1: Update dependencies
- S2: Fix command injection
- S3: Add rate limiting
- S4: Add request validation schemas
- S5: Add security headers
- E5: Add network timeouts

### Phase 2: Resilience & Failure Visibility (2-4 days)
- E1: Add React error boundaries
- E2: Audit/fix empty catch blocks
- E3: Fix fire-and-forget fetches
- E4: Add unhandled rejection handlers
- F1: Add regression test for migration failure

### Phase 3: Performance Correctness (3-5 days)
- P1: Cap terminal buffer growth
- P2: Review attachment retention
- P3: Benchmark and add index if needed
- P4: Convert hot-path sync I/O
- F2: Document pendingDeltaRef cleanup

### Phase 4: Type Safety & Cleanup (1 sprint)
- T1: Replace `any` in risky surfaces
- D1: Remove unused dependencies
- D2: Delete orphan files
- Extract shared constants
- Consolidate duplicate code

### Phase 5: Refactors & Test Expansion (1-2 sprints)
- A1: Decompose god files
- A2: Expand test coverage
- Password policy decision
- Bash sandboxing RFC

---

## Ownership

| Area | Items |
|------|-------|
| **CLI** | S2, E2, E4, E5, P4, T1 (mcp.ts, remote.ts, daemon.ts) |
| **Server** | S1, S3, S4, S5, P1, P2, P3, F1 |
| **UI** | E1, E3, T1 (App.tsx), A1, A2 |
| **Cross-cutting** | D1, D2, constants, duplicates |

---

## Realistic Timeline

| Phase | Effort | Duration |
|-------|--------|----------|
| Phase 0 | 8-12h | 1-2 days |
| Phase 1 | 24-32h | 3-5 days |
| Phase 2 | 16-24h | 2-4 days |
| Phase 3 | 20-30h | 3-5 days |
| Phase 4 | 1 sprint | ~2 weeks |
| Phase 5 | 1-2 sprints | ~2-4 weeks |
| **Total** | ~4-6 weeks | Deliberate pace |

---

*Corrected report based on manual verification of original 6-session parallel audit.*
