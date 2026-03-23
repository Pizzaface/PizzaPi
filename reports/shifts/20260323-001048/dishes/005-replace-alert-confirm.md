# Dish 005: Replace alert/confirm in RunnerManager

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** SivhU2C0
- **Dependencies:** none
- **Files:** packages/ui/src/components/RunnerManager.tsx
- **Verification:** bun run typecheck
- **Status:** queued

## Task Description

`RunnerManager.tsx` uses native `alert()` and `confirm()` calls (lines 84, 100, 111) which block the main thread and look unprofessional.

**Fix:**
1. Replace `confirm("Stop this runner?...")` (line 100) with a Radix `AlertDialog` component — show a proper confirmation dialog with Cancel/Confirm buttons
2. Replace `alert("Failed to restart runner:...")` (line 84) and `alert("Failed to stop runner:...")` (line 111) with a toast notification or inline error state
3. Use the existing UI patterns — check how other components in the project handle confirmations and error display (look for AlertDialog, toast, or similar patterns in the codebase)
4. Import any needed Radix/shadcn components

**Do NOT change the actual API calls or runner management logic** — only replace the UI feedback mechanism.
