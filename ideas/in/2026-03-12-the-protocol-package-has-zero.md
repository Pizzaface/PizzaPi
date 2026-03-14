---
id: JCQ1ltcz
project: PizzaPi
topics:
    - testing
    - protocol
    - type-safety
    - contract-testing
status: in
created: "2026-03-12T23:10:21-04:00"
updated: "2026-03-12T23:10:21-04:00"
---

The `protocol` package has ZERO tests (called out in AGENTS.md with ⚠️). It defines all the shared types and Socket.IO event contracts between runner, server, and UI. This is the most critical package to test — type mismatches between protocol definitions and actual usage are silent bugs that only surface at runtime. 

Could add: schema validation tests, contract tests ensuring server/client events match protocol definitions, serialization round-trip tests.
