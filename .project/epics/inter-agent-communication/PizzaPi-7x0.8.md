---
name: Web UI Session Topology Tree + Inter-Agent Message Panel
status: open
created: 2026-03-05T15:02:12Z
updated: 2026-03-05T15:11:13Z
beads_id: PizzaPi-7x0.8
depends_on: [PizzaPi-7x0.2]
parallel: true
conflicts_with: [PizzaPi-7x0.9]
---

# Task: Web UI Session Topology Tree + Inter-Agent Message Panel

## Description

Add two new UI components to the session viewer: (1) a session topology tree showing parent→child relationships in the sidebar, and (2) a collapsible inter-agent message panel showing chronological message flow between sessions. Both components derive their data from existing session state enriched with `parentSessionId` and `childSessionIds` from Task 001 — no new API endpoints needed (per AD-5).

## Acceptance Criteria

- [ ] **Topology tree** component in the session viewer sidebar showing parent→child hierarchy
- [ ] Each tree node displays: session name, model badge, status indicator (green dot=active, gray=idle, check=completed, red=error)
- [ ] Clicking a tree node navigates to that session's viewer
- [ ] Tree updates in real-time as sessions are added/removed/change status
- [ ] Current session is highlighted in the tree
- [ ] Tree collapses gracefully for sessions with no parent/children (shows nothing or a minimal indicator)
- [ ] **Inter-agent message panel** as a collapsible section in the session viewer
- [ ] Messages displayed chronologically with direction arrows (↑ sent, ↓ received)
- [ ] Completion messages styled with a distinct badge/color
- [ ] Message source (session name/ID) clearly labeled
- [ ] Panel auto-scrolls to newest messages
- [ ] Panel can be collapsed/expanded (persisted in local state)
- [ ] Data source: existing session list + `parentSessionId` field from heartbeats + new `agent_message` relay events
- [ ] All existing UI tests pass
- [ ] Responsive design: works on mobile and desktop viewports

## Technical Details

### Data Sources

- **Session list**: Already available in the UI via WebSocket session events
- **Parent/child relationships**: `parentSessionId` and `childSessionIds` fields added to session state in Task 001
- **Inter-agent messages**: New `agent_message` event type forwarded from relay to viewers (piggybacked on existing viewer event channel)

### New Components

**`packages/ui/src/components/session-topology.tsx`**
- Props: `currentSessionId: string`, `sessions: SessionInfo[]`
- Builds tree from `parentSessionId` relationships
- Renders recursive tree with expand/collapse
- Uses Radix UI `Collapsible` or custom tree component
- Status indicators via colored dots (TailwindCSS)

**`packages/ui/src/components/agent-messages-panel.tsx`**
- Props: `sessionId: string`, `messages: AgentMessage[]`
- Chronological list with direction arrows
- Completion messages get a badge
- Collapsible container with sticky header
- Auto-scroll to bottom on new messages

### Integration Points

- **Session viewer** (`packages/ui/src/components/session-viewer.tsx` or similar):
  - Add topology tree to sidebar
  - Add agent messages panel (collapsible) below the main session content or in a side panel
- **Session state hooks**: Extend existing hooks to include `parentSessionId` and `childSessionIds`
- **WebSocket event listener**: Subscribe to `agent_message` events for the viewed session

### Styling

- Follow existing shadcn/ui + TailwindCSS patterns
- Tree node: `flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer`
- Status dots: `w-2 h-2 rounded-full` with color variants
- Message panel: consistent with existing chat/terminal styling

### Files Affected

- `packages/ui/src/components/session-topology.tsx` — new
- `packages/ui/src/components/agent-messages-panel.tsx` — new
- `packages/ui/src/components/session-viewer.tsx` (or equivalent) — integration
- `packages/ui/src/hooks/` — extend session state hooks
- New test files for components

## Dependencies

- [ ] Task 001 must be complete (`parentSessionId`/`childSessionIds` in session state)
- [ ] No dependency on CLI tasks (002-004) — UI reads from server-side session state
- [ ] Coordinate with Task 008 on shared session data hooks (conflicts_with)

## Effort Estimate

- Size: L
- Hours: 16-24
- Parallel: true (depends only on Task 001, can be developed alongside CLI tasks)

## Definition of Done

- [ ] Code implemented
- [ ] Tests written and passing
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Visual testing: topology tree renders correctly for 1, 3, and 10+ session hierarchies
- [ ] Visual testing: message panel shows messages with correct direction and formatting
- [ ] Responsive testing: works on mobile viewport
- [ ] Code reviewed
