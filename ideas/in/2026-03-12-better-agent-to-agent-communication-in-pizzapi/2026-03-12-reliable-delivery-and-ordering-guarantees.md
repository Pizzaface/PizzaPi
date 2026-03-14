---
id: WUoeal2B
project: PizzaPi
topics:
    - agent-communication
    - reliability
    - message-ordering
    - delivery-guarantees
status: in
created: "2026-03-12T19:38:24-04:00"
updated: "2026-03-12T19:38:24-04:00"
parent: RBqkWp2M
---

Reliable delivery and ordering guarantees for inter-agent messages. Current system has no guarantees that messages arrive or arrive in order.

Possible approaches:
- **Sequence numbers** per sender-receiver pair to detect gaps and reorder
- **Ack/nack** — receiver confirms receipt, sender retries on timeout
- **At-least-once vs. exactly-once** — what semantics do we actually need? Exactly-once is expensive; at-least-once with idempotency keys might be enough
- **Persistent message queue** — messages survive agent crashes/restarts
- **Dead letter queue** — what happens to messages for agents that never come back?
