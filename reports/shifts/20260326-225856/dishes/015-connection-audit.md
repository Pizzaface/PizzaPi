# Dish 015: Frontend-Backend Connection Audit & Optimization

- **Cook Type:** codex
- **Complexity:** M
- **Godmother ID:** —
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Service:** 3 (Connection Efficiency)
- **Files:** packages/ui/src/** (read + fix), packages/server/src/**
- **Verification:** Document all socket/HTTP connections, identify consolidation opportunities
- **Status:** queued
- **Band:** A
- **dispatchPriority:** high

## Task Description
Audit ALL connections between frontend and backend:
1. Count every WebSocket namespace (/hub, /relay, /viewer, service channels)
2. Count every HTTP endpoint called on load and during session use
3. Map which data flows over which connection
4. Identify: duplicate connections, oversized payloads, connections that could share a transport
5. Propose consolidation plan — output as Godmother ideas + implement quick wins
6. Specifically investigate: can service channels share a single multiplexed socket?
