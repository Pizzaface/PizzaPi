---
id: RBqkWp2M
project: PizzaPi
topics:
    - agent-communication
    - inter-agent
    - messaging
    - architecture
status: in
created: "2026-03-12T19:37:42-04:00"
updated: "2026-03-12T19:37:42-04:00"
---

Better agent-to-agent communication in PizzaPi. Current pain points:

1. **Messages get lost or arrive out of order** — no reliability guarantees
2. **No broadcast** — can only send to one agent at a time, no way to fan out to multiple agents
3. **Passive polling model** — agents must explicitly call `check_messages` or `wait_for_message` to receive; messages aren't actively injected into the conversation, so agents can miss things if they're busy doing other work

The ideal would be a communication layer where messages are reliably delivered, can target multiple agents, and are pushed into the agent's context rather than requiring polling.
