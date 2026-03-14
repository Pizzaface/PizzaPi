---
id: CJyAASqL
project: PizzaPi
topics:
    - refactoring
    - code-quality
    - cli
    - maintainability
status: in
created: "2026-03-12T23:10:21-04:00"
updated: "2026-03-12T23:10:21-04:00"
---

The `remote.ts` extension is 2,762 lines — the largest file in the CLI by far. It likely handles relay connection, session management, event forwarding, and more. This is a prime candidate for decomposition into smaller, focused modules (e.g., relay-connection.ts, session-lifecycle.ts, event-relay.ts). Would make it testable, readable, and easier to modify.
