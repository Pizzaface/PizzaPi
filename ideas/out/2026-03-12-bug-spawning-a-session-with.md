---
id: TOjRhwFP
project: PizzaPi
topics:
    - bug
    - runner
    - agent-sessions
    - safety
status: out
created: "2026-03-12T23:04:38-04:00"
updated: "2026-03-13T09:28:15-04:00"
---

Bug: Spawning a session with `agent.name` but no inline `systemPrompt` silently falls back to a generic session when the agent file is missing on disk. In `packages/cli/src/runner/daemon.ts` (`new_session` handler), `readAgentContent()` failure only logs a warning and still spawns with `PIZZAPI_WORKER_AGENT_NAME` set. Result: user thinks they started a constrained agent (e.g. read-only researcher) but gets normal unrestricted behavior and no UI error. Expected: fail spawn with `session_error` if named agent cannot be resolved (unless explicit inline `systemPrompt` is provided). Impact: wrong behavior + potential safety regression.
