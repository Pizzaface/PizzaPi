---
name: Web UI trigger panel in session viewer
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.9
depends_on: [PizzaPi-huz.2]
parallel: true
conflicts_with: []
---

# Task: Web UI trigger panel in session viewer

## Description

Add a read-only "Triggers" panel to the session viewer in the web UI that shows active triggers for the viewed session, their configuration, firing count, and recent firing history. The panel updates in real-time as triggers are registered, fired, or cancelled.

## Acceptance Criteria

- [ ] New `TriggerPanel.tsx` component in `packages/ui/src/components/session-viewer/`
- [ ] Panel shows: trigger type, target config summary, delivery mode, firing count, last fired timestamp
- [ ] Each trigger is a collapsible row with full details (config, message template, expiresAt)
- [ ] Panel shows "No active triggers" when session has no triggers
- [ ] Real-time updates: panel reflects new registrations, firings, and cancellations within 2s
- [ ] Trigger firing count updates live when a trigger fires
- [ ] Panel integrated into `SessionViewer.tsx` as a collapsible section
- [ ] Read-only — no create/cancel actions from the UI
- [ ] Responsive layout works on mobile and desktop
- [ ] Uses existing UI patterns (Radix UI components, Tailwind v4 styles, shadcn/ui)

## Technical Details

### Files to create/modify

- **Create**: `packages/ui/src/components/session-viewer/TriggerPanel.tsx`
- **Modify**: `packages/ui/src/components/SessionViewer.tsx` — integrate TriggerPanel
- **Modify**: Viewer protocol or heartbeat parsing to include trigger data

### Data source

Triggers data arrives via one of two mechanisms (choose simplest):

**Option A — Heartbeat extension**: Include a `triggers` summary in heartbeat events. The session viewer already processes heartbeats for cost/model info. Add a `triggers: TriggerRecord[]` field to the heartbeat data.

**Option B — Dedicated viewer event**: Server emits `trigger_update` events to viewers when triggers change. Requires new viewer protocol events.

**Recommended**: Option A (heartbeat) for simplicity — avoids new viewer protocol events. The trigger list is small (<100 items) and heartbeats fire every 10s, which meets the 2s update requirement for most cases.

### Component structure

```tsx
<TriggerPanel triggers={triggers}>
  <TriggerRow trigger={trigger}>
    <TriggerTypeIcon type={trigger.type} />
    <TriggerSummary config={trigger.config} />
    <TriggerStats firingCount={trigger.firingCount} lastFiredAt={trigger.lastFiredAt} />
    <TriggerDetails config={trigger.config} message={trigger.message} /> {/* collapsible */}
  </TriggerRow>
</TriggerPanel>
```

### Trigger type display

| Type | Icon/Label | Summary format |
|------|-----------|----------------|
| session_ended | 🏁 Session Ended | "Watching N sessions" or "All sessions" |
| session_idle | 💤 Session Idle | "Watching N sessions" or "All sessions" |
| session_error | ❌ Session Error | "Watching N sessions" or "All sessions" |
| cost_exceeded | 💰 Cost Exceeded | "Threshold: $X.XX" |
| custom_event | 📢 Custom Event | "Event: {eventName}" |
| timer | ⏱️ Timer | "{delaySec}s" + "recurring" badge if applicable |

## Dependencies

- [ ] Task 001 (Protocol types) — `TriggerRecord` interface for rendering
- [ ] Task 005 (Server handlers) — trigger data available in heartbeat or viewer events

## Effort Estimate

- Size: M
- Hours: 4
- Parallel: true (can develop with mock data, wire up to real data when server tasks complete)

## Definition of Done

- [ ] Component implemented with proper TypeScript types
- [ ] Renders correctly with 0, 1, and 10+ triggers
- [ ] Mobile responsive layout verified
- [ ] Integrated into SessionViewer
- [ ] `bun run typecheck` passes
- [ ] UI builds without errors
