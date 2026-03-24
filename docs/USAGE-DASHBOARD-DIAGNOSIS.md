# Usage Dashboard — Diagnosis & Fix Plan

**Date:** 2026-03-24  
**Branch:** `diag/usage-dashboard`  
**Status:** Diagnosis complete, fixes identified

---

## Symptoms

The Usage Dashboard tab on the Runner Detail Panel is not displaying data.

---

## Root Cause Analysis

### Bug 1 (Critical): Missing `credentials: "include"` on fetch — 401 Unauthorized

**File:** `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx`  
**Line:** 29–35

The `UsageDashboard` component makes a `fetch()` call to `/api/runners/:id/usage` **without `credentials: "include"`**. This means the browser does not send the session cookie with the request.

The server endpoint (`packages/server/src/routes/runners.ts:765`) calls `requireSession(req)`, which reads the session from the cookie. Without the cookie, it returns `401 Unauthorized`.

**Every other fetch call in the UI** includes `credentials: "include"` — this was simply missed when the Usage Dashboard was added.

**Fix:**
```diff
  const response = await fetch(
    `/api/runners/${encodeURIComponent(runnerId)}/usage?range=${range}`,
    {
      headers: {
        Accept: "application/json",
      },
+     credentials: "include",
    },
  );
```

**Impact:** This is the primary reason the dashboard shows an error. Fixing this alone should make the dashboard functional.

---

### Bug 2 (Minor): Unhandled Promise rejection in `triggerScan()`

**File:** `packages/cli/src/usage/index.ts`  
**Lines:** 14, 32

`initUsage()` and `getData()` both call `triggerScan()` without `.catch()`. If the scan throws (e.g., file permission error, corrupt JSONL), the Promise rejection is unhandled and silently swallowed.

This means:
- If the initial scan fails, the DB stays empty forever (until daemon restart)
- No error is logged — the failure is invisible
- The stale-scan re-trigger in `getData()` also silently fails

**Fix:**
```diff
  export function initUsage(): void {
    db = openUsageDb();
-   triggerScan();
+   triggerScan().catch((err) => {
+     console.error("[usage] initial scan failed:", err);
+   });
  }

  export function getData(range: UsageRange = "90d"): UsageData | null {
    if (!db) return null;
    if (Date.now() - lastScanAt > 60_000) {
-     triggerScan();
+     triggerScan().catch((err) => {
+       console.error("[usage] background scan failed:", err);
+     });
    }
    return getUsageData(db, range);
  }
```

---

### Issue 3 (Data): Empty DB returns all-zeros — misleading "No data" state

**Files:** `packages/cli/src/usage/aggregator.ts`, `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx`

When the usage DB exists but is empty (e.g., scan hasn't completed yet, or sessions live only in `~/.pi/agent/sessions/` and the scanner hasn't found them), `getUsageData()` returns a valid object with all zeros. The UI renders this as `$0.00`, `0 Sessions`, `0K Tokens` — which looks like "working but no data" rather than "data isn't loaded yet."

The `getData()` function in `index.ts` returns `null` only when `db` itself is null. The daemon handler shows "initial scan in progress" only for `null`. An empty-but-scanned DB looks identical to "no sessions ever."

**Possible fixes:**
- Add a flag to the response indicating whether the initial scan has completed
- Have the aggregator return `null` if `lastScanAt === 0` (scan never finished)
- Show a different UI state when `totalSessions === 0` ("No sessions found" vs "Loading...")

---

### Issue 4 (Observation): Session migration may not have completed

**File:** `packages/cli/src/runner/daemon.ts:61–100`

Session JSONL files live at `~/.pi/agent/sessions/` (151 project directories). The migration function `migrateSessionStorage()` is designed to move them to `~/.pizzapi/agent/sessions/`, but this appears not to have completed on this machine.

The scanner has a fallback that checks both paths (`primaryDir` and `piDir`), so data is still found — but only if the scan actually runs. This isn't a blocking bug, but it means the scanner always has to check two directories.

**Not a fix required** — the scanner handles both paths. But it's worth understanding why the migration didn't complete. Possible reasons:
- Something recreated `~/.pi/agent/` after migration (e.g., upstream pi or Claude Code writing to its default path)
- The daemon was never restarted after the migration code was added
- The `initUsage()` call (which creates `~/.pizzapi/agent/`) runs *after* `migrateSessionStorage()`, creating a race where the target directory partially exists

---

## Fix Priority

| # | Severity | Description | Effort |
|---|----------|-------------|--------|
| 1 | **P0** | Add `credentials: "include"` to fetch | 1 line |
| 2 | **P2** | Add `.catch()` to `triggerScan()` calls | 2 lines |
| 3 | **P3** | Improve empty-state UX | Design decision |
| 4 | **P3** | Investigate migration completeness | Investigation |

---

## How to Verify

After applying Fix #1:

1. Open the PizzaPi web UI
2. Navigate to a Runner → Usage tab
3. Should see cost charts, session stats, model breakdown populated with data
4. Check browser DevTools Network tab — the `/api/runners/:id/usage` request should return 200 with JSON data

---

## Files Touched in This Diagnosis

- `packages/ui/src/components/usage-dashboard/UsageDashboard.tsx` — primary fetch bug
- `packages/cli/src/usage/index.ts` — unhandled promise rejections
- `packages/cli/src/usage/scanner.ts` — reviewed, no bugs found
- `packages/cli/src/usage/aggregator.ts` — reviewed, SQL correct
- `packages/cli/src/usage/schema.ts` — reviewed, schema correct
- `packages/server/src/routes/runners.ts` — reviewed, routing correct
- `packages/server/src/ws/namespaces/runner.ts` — reviewed, relay correct
- `packages/cli/src/runner/daemon.ts` — reviewed, handler correct
- `packages/protocol/src/runner.ts` — reviewed, types correct
