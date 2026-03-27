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

## Health Inspection — 13:03 UTC
- **Inspector Model:** claude-sonnet-4-6
- **Verdict:** CITATION
- **Findings:** P2a: service_announce dedup creates starvation window after runner crash/reconnect — viewer joined during offline gap never gets service panels; P2b: "already connected" sidebar path now 1200ms instead of immediate REST fetch; P3: isSameServiceAnnounce order-sensitive, no fallback timer test, audit doc at repo root
- **Critic Missed:** N/A (no critic ran)
