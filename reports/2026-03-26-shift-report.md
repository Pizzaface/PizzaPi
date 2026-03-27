# Night Shift Report — 2026-03-26

## ⭐⭐⭐⭐⭐ — Double Kitchen Night

## Shift Summary
- **Started:** 23:17 UTC | **Ended:** 04:36 UTC (~5h 19m)
- **Status:** ✅ Service Complete — both kitchens served
- **Main Shift:** 5 dishes → 5 served, 0 poisoned (3 services completed)
- **Critic's Choice:** 62 bugs found → 19 fixed in 4 waves, 5 deferred to Godmother
- **Total PRs:** 7 ready for morning merge

## Tonight's Menu — Main Shift

### Service 1: Tunnel Overhaul
| # | Dish | Cook | Status | PR |
|---|------|------|--------|----|
| 001 | Tunnel Overhaul: httpProxy() + cache + accept-encoding + WS headers | sonnet | served | #338 |
| 002 | Stale tunnel state on reconnect | sonnet | served | #338 |

**Pairing: tunnel-overhaul** → PR #338
- Merged `fix/tunnel-module-mime-rewriting` (3 commits: WS upgrade, path rewriting, Vite HMR)
- Added `httpProxy()` standalone function, 60s/100-entry LRU cache, accept-encoding: identity
- Fixed RFC 6455 GUID truncation, x-api-key credential stripping (3 locations)
- TunnelPanel clears stale state on disconnect
- 12 tunnel-service tests + 4 TunnelPanel tests
- **Critic:** Round 1 found P1 api-key leak → fixed. Round 2 P2 demerits (WS edge cases, logged).

### Service 2: Mobile UX & Top Bar
| # | Dish | Cook | Status | PR |
|---|------|------|--------|----|
| 003 | Mobile SessionViewer header overflow menu | sonnet | served | #339 |
| 004 | Markdown copy polish: fences + exportToMarkdown | sonnet | served | #339 |

**Pairing: session-viewer-polish** → PR #339
- New `HeaderOverflowMenu` component: ⋯ DropdownMenu on mobile with Terminal/Files/Git/Copy/Download/Duplicate
- Desktop layout unchanged, active panel checkmarks
- Code block copy now includes ` ```language ` fences via `safeFence()`
- Per-message copy uses `exportToMarkdown([message])` for rich markdown
- **Critic:** Round 1 duplicate import (merge artifact, fixed). Round 2 safeFence edge case (fixed). Round 3 LGTM.

### Service 3: Markdown Copy & Polish
| # | Dish | Cook | Status | PR |
|---|------|------|--------|----|
| 005 | System prompt guidance: intermediate triggers | jules | served | #337 |

**Solo dish** → PR #337
- Single-line addition to BUILTIN_SYSTEM_PROMPT: guidance on intermediate vs. final session_complete triggers
- Closes CTzqSajA

## Critic's Choice — Bug Hunt

### Scout Phase
6 Sonnet scouts deployed across all codebase sectors:

| Scout | P0 | P1 | P2 | P3 | Total |
|-------|----|----|----|----|-------|
| Server & API | 1 | 2 | 6 | 0 | 9 |
| UI Core | 0 | 4 | 6 | 2 | 12 |
| CLI & Runner | 0 | 3 | 6 | 2 | 11 |
| Real-time & WS | 0 | 2 | 7 | 1 | 10 |
| Mobile & UX | 0 | 2 | 5 | 3 | 10 |
| Protocol & Types | 0 | 2 | 6 | 2 | 10 |
| **TOTAL** | **1** | **13** | **34** | **14** | **62** |

### Wave Fixes
| Wave | PR | Fixes | Ramsey | Status |
|------|----|-------|--------|--------|
| Wave 1 — Security | #341 | 7 (1 P0 + 1 P1 + 5 P2) | 0 demerits | ✅ served |
| Wave 2 — Reconnection | #342 | 3 (2 P1 + 1 P2) | 0 demerits | ✅ served |
| Wave 3 — Triggers | #340 | 3 (2 P1 + 1 P2) | 0 demerits | ✅ served |
| Wave 4 — Mobile | #343 | 6 (2 P1 + 4 P2) | 0 demerits | ✅ served |

**19 bugs fixed, 0 Ramsey demerits across all 4 CC waves.**

### Top Finding — P0 Chat Endpoint RCE
`createToolkit()` in `/api/chat` gave every authenticated user bash/file access on the SERVER host. Fixed by removing tools entirely — chat is Q&A only.

### Deferred to Godmother (5 items)
- React state hygiene: patchSessionCache inside setMessages updaters (6+ locations) — MyhlJhuS
- Double /hub WebSocket: SessionSidebar + App create separate sockets — wexNsZ1X
- Cross-node session_message/trigger delivery fails silently — i9uAYsf7
- Attachment persistence: in-memory only, lost on restart — cmHfFF7I
- kill_session + exit(43) race condition — CVM8j9cS
- Tunnel WS proxy: orphaned connections + continuation frames — AY73LYG4

## PRs Ready for Morning Review
| # | Title | Scope |
|---|-------|-------|
| **#337** | docs(cli): parent agent trigger guidance | System prompt |
| **#338** | feat(tunnel): overhaul — WS/MIME, cache, encoding, stale state | Tunnel system |
| **#339** | feat(ui): mobile overflow menu + markdown copy polish | UI/mobile |
| **#340** | fix: trigger parser anchoring + protocol edge cases | Protocol |
| **#341** | fix(security): 7 security gaps — chat RCE, roots bypass, injection, replay | Security |
| **#342** | fix(runner): reconnection resilience — listener cleanup, panel ports | Runner daemon |
| **#343** | fix(ui): mobile polish — safe area, iOS zoom, keyboard, swipe | Mobile UX |

**⚠️ NEEDS YOUR MERGE APPROVAL — PRs are never auto-merged.**

## Usage Report
| Provider | Start | End |
|----------|-------|-----|
| anthropic | — | — (credentials confirmed, % not reported) |
| openai-codex | 3% / 49% | ~15% / ~55% (estimated from session count) |
| google-gemini-cli | 0% / 0% | 0% / 0% |
| jules | — | 1 session completed |

## Shift Statistics
| Metric | Main | CC | Total |
|--------|------|----|-------|
| Dishes/Waves | 5 | 4 | 9 |
| PRs Created | 3 | 4 | 7 |
| Cook Sessions | 7 | 4 | 11 |
| Fixer Sessions | 3 | 0 | 3 |
| Critic Sessions | 5 | 0 | 5 |
| Ramsey Reviews | 8 | 4 | 12 |
| Scout Sessions | 0 | 6 | 6 |
| Total Sessions | 15 | 14 | 29 |
| Bugs Found | — | 62 | 62 |
| Bugs Fixed | — | 19 | 19 |

## Kitchen Incidents
- Dish 001 Ramsey send-back round 1: WS forwardHeaders dropped (inherited from fix branch) → fixed
- PR #338 critic round 1: P1 api-key credential leak to tunneled services → fixed
- PR #339 critic rounds 1+2: duplicate import (merge artifact) + safeFence edge case → both fixed
- Prep demerit: AskUserQuestion called during `--autonomous` shift (should have been self-directed)

## Follow-Up Work (Captured in Godmother)
| ID | Title | Status |
|----|-------|--------|
| raTUsyjy | CRITICAL — Chat endpoint RCE | review (fixed in PR #341) |
| MyhlJhuS | React state hygiene — concurrent mode violations | capture |
| wexNsZ1X | Double /hub WebSocket connection | capture |
| i9uAYsf7 | Cross-node messaging delivery | capture |
| cmHfFF7I | Attachment persistence — in-memory only | capture |
| CVM8j9cS | kill_session + exit(43) race | capture |
| AY73LYG4 | Tunnel WS proxy edge cases | capture |
