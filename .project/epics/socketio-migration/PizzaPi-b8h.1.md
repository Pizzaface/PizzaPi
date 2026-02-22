---
name: Bun + Socket.IO Compatibility Spike
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.1
depends_on: []
parallel: false
conflicts_with: []
---

# Task: Bun + Socket.IO Compatibility Spike

## Description

Verify that Socket.IO v4.8+ works reliably with Bun.serve on both server and client sides before committing to the migration. This is a go/no-go gate for the entire epic.

## Acceptance Criteria

- [ ] Socket.IO Server attaches to Bun.serve and accepts WebSocket connections
- [ ] `socket.io-client` connects from a Bun process (simulating CLI/runner)
- [ ] `socket.io-client` connects from a browser (Vite dev server)
- [ ] `@socket.io/redis-adapter` initializes and broadcasts across two local server instances
- [ ] Connection State Recovery works (disconnect + reconnect within 2 min resumes events)
- [ ] Namespace-based connections work (`io.of("/relay")`, etc.)
- [ ] Documented any workarounds needed (e.g., `node:http` compat layer)

## Technical Details

- Create a minimal `spike/` directory with a test server and test clients
- Server: Bun.serve + Socket.IO with Redis adapter, 2-3 namespaces
- Client 1: Bun script using `socket.io-client` (WS-only transport)
- Client 2: Simple HTML page using `socket.io-client` (default transport)
- Test cross-server fan-out by running two server instances on different ports
- Measure round-trip latency for event relay

### Key Risk Areas
- Bun's `node:http` compatibility layer may have gaps
- `socket.io-client` engine.io transport may behave differently in Bun vs Node
- Redis adapter pub/sub may need Bun-specific connection handling

## Dependencies

- [ ] None — this is the first task

## Effort Estimate

- Size: S
- Hours: 4
- Parallel: false (gates all other work)

## Definition of Done

- [ ] Spike code demonstrates all acceptance criteria
- [ ] Written summary of findings (works / doesn't work / workarounds needed)
- [ ] Go/no-go decision documented
- [ ] Spike code can be deleted (not production code)
