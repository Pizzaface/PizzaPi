# Scout Report: Mobile & UX
**Scout:** e01d5f3a-d418-427b-b4a9-3d929328c8c7
**Sector:** Mobile & UX
**Completed:** 2026-03-26 03:51 UTC

## Findings (10 bugs)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | **P1** | Full-screen panel overlay missing safe-area-inset-top — content under notch | App.tsx:3590 |
| 2 | **P1** | CommandInput text-sm (14px) triggers iOS auto-zoom on focus | command.tsx:73 |
| 3 | P2 | Session card swipe missing onPointerCancel — timer/state leak | SessionSidebar.tsx:330 |
| 4 | P2 | Session switcher max-h-[70vh] — items behind keyboard unreachable | App.tsx:3538 |
| 5 | P2 | useMobileSidebar swipe no lower bound — sidebar flies off-screen | useMobileSidebar.ts:60 |
| 6 | P2 | useMobileSidebar overflow:hidden races with Radix dialog scroll lock | useMobileSidebar.ts:97 |
| 7 | P2 | Sidebar overlay missing touchAction:none — vertical swipe scrolls behind | App.tsx:3571 |
| 8 | P3 | Haptics tool-typing interval runs while page is backgrounded | haptics.ts:107 |
| 9 | P3 | Programmatic textarea.focus() raises keyboard unexpectedly on mobile | SessionViewer.tsx:2130 |
| 10 | P3 | IframeServicePanel missing allow-modals in sandbox attr | IframeServicePanel.tsx:15 |

## Score
**0 P0, 2 P1, 5 P2, 3 P3** — deep mobile-specific findings, highly actionable.
