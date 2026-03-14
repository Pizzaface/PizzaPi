---
id: BeBzY5Mz
project: PizzaPi
topics:
    - agent-communication
    - redis
    - message-bus
    - reliability
    - infrastructure
status: in
created: "2026-03-12T23:10:21-04:00"
updated: "2026-03-12T23:10:21-04:00"
---

The inter-agent message bus (`session-message-bus.ts`) is a pure in-memory singleton. Messages don't survive process restarts, there's no persistence, and if an agent crashes mid-conversation the entire message history is lost. 

Redis is already a dependency for the server — the message bus should use Redis pub/sub or streams for durability and cross-process delivery. This would also naturally solve the "messages get lost" pain point since Redis Streams support consumer groups, acknowledgments, and replay.
