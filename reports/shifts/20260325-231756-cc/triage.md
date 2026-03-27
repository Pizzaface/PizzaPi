# Critic's Choice Triage — 62 Bugs Found

## All 6 Scouts Complete

| Scout | P0 | P1 | P2 | P3 | Total |
|-------|----|----|----|----|-------|
| Server & API | 1 | 2 | 6 | 0 | 9 |
| Mobile & UX | 0 | 2 | 5 | 3 | 10 |
| UI Core | 0 | 4 | 6 | 2 | 12 |
| CLI & Runner | 0 | 3 | 6 | 2 | 11 |
| Real-time & WS | 0 | 2 | 7 | 1 | 10 |
| Protocol & Types | 0 | 2 | 6 | 2 | 10 |
| **TOTAL** | **1** | **13** | **34** | **14** | **62** |

## Cross-Scout Overlaps (Deduplicate)
- Double /hub socket (UI Core #2 = Real-time #5) → count once
- Cross-node messaging (Server #5 = Real-time #2 + #8) → count once
- Listener stacking on reconnect (CLI #1 = CLI #3 — same root cause) → count once

**Unique bugs after dedup: ~57**

## Wave Formation

### Wave 1 — Security Hardening (P0 + security-adjacent P1/P2)
**Priority: HIGHEST — cook immediately**
| Bug | Severity | Source | Fix Scope |
|-----|----------|--------|-----------|
| Chat endpoint RCE (bash/file tools on server) | P0 | Server #1 | chat.ts — remove createToolkit() |
| Terminal cwd bypasses workspace-roots | P1 | Server #3 | runners.ts — add roots check |
| File explorer/search/git skip roots validation | P2 | Server #4 | runners.ts — add roots checks |
| Runner service_message injection — no ownership check | P1 | Real-time #1 | runner.ts — add sessionId ownership guard |
| Viewer trigger_response cross-session injection | P2 | Real-time #7 | viewer.ts — add parent-child check |
| OAuth nonce store cleared globally — replay window | P2 | Server #9 | mcp-oauth.ts — TTL-based eviction |
| Attachment upload to null-userId sessions | P2 | Server #7 | attachments.ts — fix ownership guard |

**Files:** chat.ts, runners.ts, runner.ts (server ws), viewer.ts, mcp-oauth.ts, attachments.ts
**Estimated complexity:** M (7 surgical fixes, all one-liners or small blocks)

### Wave 2 — Reconnection Resilience (systemic P1)
**Priority: HIGH — cook after Wave 1**
| Bug | Severity | Source | Fix Scope |
|-----|----------|--------|-----------|
| Socket listeners stack N+1 on reconnect (all services) | P1 | CLI #1 | All 4 service handlers — socket.off() in dispose() |
| Panel tunnel ports cleared on reconnect — 404 | P1 | CLI #2 | daemon.ts — re-register panel ports |
| runner_registered async handler no try/catch | P2 | CLI #5 | daemon.ts — wrap in try/catch |

**Files:** terminal-service.ts, file-explorer-service.ts, git-service.ts, tunnel-service.ts, daemon.ts
**Estimated complexity:** M (systematic but repetitive — same pattern across all services)

### Wave 3 — Trigger & Protocol Fixes
**Priority: HIGH — directly affects Night Shift operations**
| Bug | Severity | Source | Fix Scope |
|-----|----------|--------|-----------|
| Unanchored trigger parsers misclassify session_complete | P1+P1 | Protocol #1+#2 | trigger-parsers.ts — anchor regexes |
| Empty-string trigger response silently dropped | P2 | Protocol #4 | viewer.ts + messaging.ts — fix null check |
| Multi-question fallback discards answers | P2 | Protocol #3 | ask-user-answer-parser.ts — map to all questions |

**Files:** trigger-parsers.ts, viewer.ts, messaging.ts, ask-user-answer-parser.ts
**Estimated complexity:** S (focused string/logic fixes)

### Wave 4 — Mobile Polish
**Priority: MEDIUM**
| Bug | Severity | Source | Fix Scope |
|-----|----------|--------|-----------|
| Panel overlay missing safe-area-inset-top | P1 | Mobile #1 | App.tsx — add pp-safe-top |
| CommandInput 14px triggers iOS auto-zoom | P1 | Mobile #2 | command.tsx — text-base md:text-sm |
| Session switcher max-h-[70vh] → [70dvh] | P2 | Mobile #4 | App.tsx — use dvh |
| Sidebar overlay missing touchAction:none | P2 | Mobile #7 | App.tsx — add style |
| Sidebar swipe no lower bound clamp | P2 | Mobile #5 | useMobileSidebar.ts — add Math.max |
| Swipe missing onPointerCancel | P2 | Mobile #3 | SessionSidebar.tsx — add handler |

**Files:** App.tsx, command.tsx, useMobileSidebar.ts, SessionSidebar.tsx
**Estimated complexity:** S-M (CSS + small logic fixes)

### Deferred to Godmother (too complex or too risky for tonight)
- React state hygiene (UI Core P1s) — 6+ locations in App.tsx, refactor-level
- Double /hub socket — architectural, needs context/singleton design
- Cross-node messaging fallback — multi-process infrastructure
- Attachment persistence (Server P1) — needs DB migration
- Kill/restart race conditions — daemon lifecycle, needs careful testing
- isCwdAllowed effectiveCwd gap — security-adjacent but edge case

## Cook Plan
- **Wave 1:** Dispatch immediately as a single Sonnet cook (7 security fixes, one branch)
- **Wave 2:** Dispatch after Wave 1 plates (reconnection fixes, one branch)
- **Wave 3:** Dispatch in parallel with Wave 2 (trigger/protocol, separate files)
- **Wave 4:** Dispatch after Wave 2/3 plate (mobile polish, one branch)
- **Deferred:** Capture to Godmother for next shift
