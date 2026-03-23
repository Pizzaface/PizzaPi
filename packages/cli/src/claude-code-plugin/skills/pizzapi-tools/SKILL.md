# PizzaPi Tools

These tools are available in this session via the `pizzapi` MCP server.

## Inter-Session Communication

- **`pizzapi_spawn_session`** — Spawn a child session on the PizzaPi runner. Returns `{ sessionId, shareUrl }`. Spawned sessions are automatically linked as children (triggers flow back to this session).
- **`pizzapi_send_message`** / **`pizzapi_wait_for_message`** / **`pizzapi_check_messages`** — Async messaging between sessions. `wait_for_message` blocks up to 20s; call in a loop for longer waits.
- **`pizzapi_get_session_id`** — Returns this session's stable ID (for use in `send_message` calls from other sessions).

## Trigger System

When a child session completes, a `session_complete` trigger arrives as a user message. Use:
- **`pizzapi_respond_to_trigger`** — Reply to a pending trigger with `action: "ack"` or `action: "followUp"`.
- **`pizzapi_tell_child`** — Proactively send instructions to a running child.
- **`pizzapi_escalate_trigger`** — Forward a trigger to the human viewer.

## Session Info

- **`pizzapi_list_models`** — List models configured on this runner.
