---
id: objIRm1n
project: PizzaPi
topics:
    - agent-communication
    - message-injection
    - push-model
    - conversation-context
status: in
created: "2026-03-12T19:38:23-04:00"
updated: "2026-03-12T19:38:23-04:00"
parent: RBqkWp2M
---

Push-based message injection for agent communication. Instead of agents polling with `check_messages` / `wait_for_message`, messages from other agents would be actively injected into the receiving agent's conversation context.

Open questions:
- How to interrupt an agent mid-tool-call without corrupting state?
- Should injected messages appear as system messages, user messages, or a new role?
- Priority levels — can urgent messages preempt current work vs. queue for next turn?
- What happens if an agent is in the middle of a multi-step plan — inject between steps?
