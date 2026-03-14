---
id: uTWRUjFU
project: PizzaPi
topics:
    - testing
    - mocking
    - developer-experience
    - test-harness
status: in
created: "2026-03-12T23:07:37-04:00"
updated: "2026-03-12T23:07:37-04:00"
---

A mocking/test harness for PizzaPi conversations, messages, and other primitives. Need a way to simulate and test:

- **Conversations** — mock message sequences, tool calls, and responses without hitting real LLMs
- **Inter-agent messages** — simulate send_message/wait_for_message/check_messages without real sessions
- **Tool call results** — stub out tool responses for deterministic test scenarios
- Other PizzaPi internals (sessions, MCP servers, etc.)

Would enable writing proper unit/integration tests for agents, skills, extensions, and plugins without needing live infrastructure.
