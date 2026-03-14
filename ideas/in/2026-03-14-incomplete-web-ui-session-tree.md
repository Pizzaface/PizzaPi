---
id: ygQb90s5
project: PizzaPi
topics:
    - ui
    - triggers
    - session-linking
    - incomplete
    - v1-scope
status: in
created: "2026-03-14T00:09:10-04:00"
updated: "2026-03-14T00:09:10-04:00"
---

**Incomplete: Web UI session tree and trigger cards not implemented**

Per the linked-sessions-conversation-triggers spec, the following UI features are required for V1 but not yet implemented:

1. **Session tree in sidebar** — Child sessions should be indented under parent with collapsible tree structure. Currently only shows arrow indicator (↳) on child sessions.

2. **Trigger cards in conversation view** — Trigger-injected messages (ask_user_question, plan_review, session_complete, etc.) should render as distinct cards with:
   - Icon + child session name
   - Trigger type badge  
   - Structured payload display (question + options, plan steps, etc.)
   - "Respond" button for interactive triggers

These are mapped to Tasks 18-19 in the implementation plan at `docs/superpowers/plans/2026-03-13-linked-sessions-triggers.md`.

The trigger system backend is complete and working (triggers fire, render as text with metadata), but the UI needs to:
- Parse `<!-- trigger:ID -->` metadata prefix from injected messages
- Render as distinct TriggerCard components instead of plain messages  
- Build and display hierarchical session tree from flat session list using `parentSessionId`

