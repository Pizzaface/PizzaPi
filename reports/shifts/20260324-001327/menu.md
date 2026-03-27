# Tonight's Menu

**Goal:** Complete test factory harness for PizzaPi — mock runners, sessions, conversation history, BDD-style testing.

| # | Dish | Cook Type | Complexity | Dependencies | Godmother ID | Status |
|---|------|-----------|------------|--------------|--------------|--------|
| 001 | Test Server Factory — spin up real server + Socket.IO on ephemeral port | sonnet | L | none | uTWRUjFU | queued |
| 002 | Mock Runner Client — Socket.IO client that mimics a runner daemon | sonnet | M | 001 | Q88RyiEr | queued |
| 003 | Mock Session & Conversation Builders — factories for sessions, events, heartbeats | sonnet | M | 001 | uTWRUjFU | queued |
| 004 | Mock Viewer Client — Socket.IO client for the /viewer and /hub namespaces | sonnet | M | 001 | uTWRUjFU | queued |
| 005 | BDD Scenario Helpers & Integration Tests — Given/When/Then wrappers + demo tests | sonnet | M | 001, 002, 003, 004 | uTWRUjFU | queued |
| 006 | Documentation — README, JSDoc, usage examples in tests | sonnet | S | 005 | uTWRUjFU | queued |
