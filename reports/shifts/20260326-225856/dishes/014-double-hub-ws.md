# Dish 014: Fix Double /hub WebSocket Connection

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** wexNsZ1X
- **Dependencies:** none
- **Pairing:** connection-efficiency
- **Pairing Role:** related
- **Paired:** true
- **Service:** 3 (UI Stability / Connection Efficiency)
- **Files:** packages/ui/src/App.tsx, packages/ui/src/components/SessionSidebar.tsx
- **Verification:** bun test packages/ui, bun run typecheck, verify single /hub socket in Network tab
- **Status:** stoppage
- **Band:** A
- **dispatchPriority:** high

## Task Description
SessionSidebar and App each open separate /hub WebSocket connections. Consolidate to a single shared socket. This is a P1 — doubles server load and causes race conditions on state updates.
