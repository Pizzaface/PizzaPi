---
name: End-to-End Validation and Multi-Server Fan-Out Testing
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.10
depends_on: [PizzaPi-b8h.6, PizzaPi-b8h.7, PizzaPi-b8h.8, PizzaPi-b8h.9]
parallel: false
conflicts_with: []
---

# Task: End-to-End Validation and Multi-Server Fan-Out Testing

## Description

Comprehensive testing of the complete Socket.IO migration: all features work end-to-end, multi-server fan-out works via Redis adapter, reconnection is seamless, backward compatibility holds, and performance meets targets.

## Acceptance Criteria

- [ ] **Session viewing**: Browser viewer sees all TUI events in real-time
- [ ] **Collab mode**: Viewer can send messages that reach the TUI agent
- [ ] **Runner management**: Runner daemon registers, receives new_session, spawns workers correctly
- [ ] **Terminal streaming**: Web terminal PTY works (input + output)
- [ ] **Hub session list**: SessionSidebar shows live session list updates
- [ ] **Push notifications**: Sent when no viewers connected (cross-server check)
- [ ] **Multi-server fan-out**: TUI on server A → viewer on server B receives events < 100ms
- [ ] **Reconnection**: Brief disconnect (< 2 min) resumes without manual resync
- [ ] **Backward compat**: Old CLI version connects via raw WS alongside new Socket.IO clients
- [ ] **Code metrics**: Net ≥ 300 lines removed from WS-related code
- [ ] **Type safety**: Zero `as any` casts in event handlers (verified by grep)
- [ ] **Bundle size**: UI bundle increase < 50KB gzipped

## Technical Details

### Test Scenarios

#### Single-Server Tests
1. Start server + connect TUI via CLI → verify session appears in hub
2. Open browser viewer → verify events stream in real-time
3. Send viewer message in collab mode → verify TUI receives it
4. Spawn terminal via runner → verify PTY works in browser
5. Disconnect viewer network → reconnect within 2 min → verify no event gap
6. Disconnect viewer > 2 min → reconnect → verify Redis replay works

#### Multi-Server Tests
7. Start 2 server instances (different ports, same Redis)
8. Connect TUI to server A, viewer to server B → verify events flow
9. Connect runner to server A, send new_session from server B → verify runner receives it
10. Check hub on server B shows sessions from server A
11. Kill server A → verify viewer reconnects to server B

#### Backward Compatibility Tests
12. Connect old CLI (raw WS) to server → verify session works
13. Connect new CLI (Socket.IO) alongside old CLI → verify both work
14. Verify deprecation warning logged for old CLI

#### Performance Tests
15. Measure event relay latency (TUI → viewer) — target < 50ms single-server, < 100ms cross-server
16. Verify no memory leaks after 1000+ events

### Metrics Collection
```bash
# Count removed lines
git diff --stat main -- packages/server/src/ws/ packages/ui/src/ packages/cli/src/extensions/remote.ts packages/cli/src/runner/daemon.ts

# Check for any casts
grep -r "as any" packages/server/src/ws/ packages/ui/src/ packages/cli/src/extensions/remote.ts packages/cli/src/runner/daemon.ts

# UI bundle size
bun run build:ui && ls -la packages/ui/dist/assets/*.js
```

## Dependencies

- [ ] All tasks 001-009 must be complete

## Effort Estimate

- Size: M
- Hours: 8
- Parallel: false (requires all other work complete)

## Definition of Done

- [ ] All test scenarios pass
- [ ] Performance targets met
- [ ] Code metrics verified (line reduction, type safety, bundle size)
- [ ] No regressions in any existing feature
- [ ] `bun run build` succeeds (full build)
- [ ] `bun run typecheck` passes
- [ ] Documentation updated (README, AGENTS.md env vars if changed)
