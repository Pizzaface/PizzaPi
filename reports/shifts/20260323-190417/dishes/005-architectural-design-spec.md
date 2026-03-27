# Dish 005: Architectural Design Spec

- **Cook Type:** opus (brainstorm)
- **Complexity:** L
- **Godmother ID:** 8uphsUaD, 9mOLVdjU
- **Dependencies:** none
- **Files:**
  - reports/shifts/20260323-190417/design-spec.md (new)
- **Verification:** Review by user + batch critic
- **Status:** served ✅

## Task Description

Produce a detailed architectural design document covering:

1. **Delta-based event architecture** — Replace full-snapshot session_active with incremental delta events. Design the protocol, the reconnect/resync flow, and the migration path from chunked delivery.

2. **Relay module architecture** — How relay.ts, viewer.ts, and runner.ts should be restructured. Module boundaries, interfaces, dependency graph.

3. **Protocol envelope** — Unified message format for all runner↔server↔UI communication. Evaluate Socket.IO vs raw WebSocket vs SSE for different communication patterns.

4. **Persistence simplification** — Reduce from three layers (Redis hashes + Redis lists + SQLite) to a cleaner model.

5. **Phased implementation plan** — Split into night-shift-sized dishes with dependency ordering.

## Output

A markdown design document that can be used to build menus for 3-4 future night shifts. Each phase should be independently shippable.
