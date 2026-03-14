---
id: rWZsh2Kg
project: PizzaPi
topics:
    - agent-communication
    - broadcast
    - pub-sub
    - channels
    - multi-agent
status: in
created: "2026-03-12T19:38:24-04:00"
updated: "2026-03-12T19:38:24-04:00"
parent: RBqkWp2M
---

Broadcast and pub/sub for multi-agent communication. Currently agents can only send point-to-point. Need a way to fan out messages to multiple agents.

Possible designs:
- **Named channels / topics** — agents subscribe to channels (e.g., "build-status", "code-review-requests"), any agent can publish
- **Agent groups** — define groups of agents that all receive the same message
- **Event bus** — fire-and-forget events that any interested agent can listen to
- **Selective broadcast** — send to all agents matching a filter (e.g., all agents in a project, all agents with a certain role)
- **Extracting side-channel vs. main-channel** — broadcast might be for coordination signals, not full conversations
