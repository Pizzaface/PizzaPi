# Pairing: session-viewer-polish

## Story
These two dishes ship as a single PR: Dish 003 restructures the SessionViewer header for mobile (overflow menu, new open-state props), and Dish 004 polishes the copy actions (fenced code blocks, per-message exportToMarkdown). Both touch SessionViewer.tsx and ship together to avoid merge conflicts and tell a complete "polish" story.

## Dishes
| # | Title | Role | Dependency |
|---|-------|------|------------|
| 003 | Mobile SessionViewer header overflow menu | prelim | none |
| 004 | Markdown copy polish | main | 003 (prelim must plate first) |

Dish 003 must plate (pass per-dish Ramsey) before Dish 004 is dispatched.

## Combined PR Title
feat(ui): mobile overflow menu + markdown copy polish

## Status
queued
