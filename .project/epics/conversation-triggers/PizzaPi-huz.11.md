---
name: Documentation for conversation triggers
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.11
depends_on: [PizzaPi-huz.6, PizzaPi-huz.8, PizzaPi-huz.9]
parallel: false
conflicts_with: []
---

# Task: Documentation for conversation triggers

## Description

Write user-facing and developer documentation for the conversation triggers feature. Update existing docs pages and create a new triggers guide with usage examples, tool reference, and architecture explanation.

## Acceptance Criteria

- [ ] New `packages/docs/src/content/docs/guides/conversation-triggers.mdx` — comprehensive guide with trigger types, delivery modes, tool reference, and workflow examples
- [ ] Update `packages/docs/src/content/docs/reference/architecture.mdx` — add trigger system to architecture diagram and component descriptions
- [ ] Update `packages/docs/src/content/docs/guides/cli-reference.mdx` — add new agent tools (register_trigger, cancel_trigger, list_triggers, emit_event)
- [ ] Update `packages/docs/src/content/docs/reference/environment-variables.mdx` — if any new env vars added (e.g., trigger limits)
- [ ] Include the 3 PRD example workflows in the guide: fan-out/fan-in, cost monitoring, pub/sub coordination
- [ ] Document trigger type reference table with all config fields
- [ ] Document delivery modes (queue vs inject) with behavioral differences
- [ ] Document runner-lock scope and security model
- [ ] Document trigger limits (100/session, 1000/runner)
- [ ] Docs site builds without errors (`cd packages/docs && bun run build`)

## Technical Details

### Files to create/modify

- **Create**: `packages/docs/src/content/docs/guides/conversation-triggers.mdx`
- **Modify**: `packages/docs/src/content/docs/reference/architecture.mdx`
- **Modify**: `packages/docs/src/content/docs/guides/cli-reference.mdx`
- **Modify**: `packages/docs/src/content/docs/reference/environment-variables.mdx` (if applicable)
- **Modify**: `packages/docs/astro.config.mjs` — add new guide to sidebar navigation

### Guide structure

```
# Conversation Triggers

## Overview
- What triggers are and why they exist
- Comparison to polling-based messaging

## Quick Start
- Register your first trigger (session_ended example)
- See it fire

## Trigger Types Reference
- Table with all 6 types, config fields, and use cases

## Delivery Modes
- queue mode: how it works, when to use
- inject mode: how it works, when to use

## Agent Tools
- register_trigger — full parameter reference
- cancel_trigger
- list_triggers
- emit_event

## Workflow Examples
- Fan-Out/Fan-In Orchestration
- Cost Monitoring
- Pub/Sub Build Coordination

## Web UI
- Trigger panel overview
- What's shown, how to read it

## Security & Scope
- Runner-lock model
- Session ownership
- Limits

## Troubleshooting
- Common issues and solutions
```

## Dependencies

- [ ] Task 005 (Server handlers) — final API shape for tool parameters
- [ ] Task 007 (CLI inject delivery) — final inject behavior
- [ ] Task 008 (UI panel) — screenshot/description of UI panel

## Effort Estimate

- Size: S
- Hours: 2
- Parallel: false (needs final API shapes)

## Definition of Done

- [ ] All documentation written
- [ ] Docs site builds without errors
- [ ] Examples are accurate and tested
- [ ] Sidebar navigation includes new guide
- [ ] No broken links
