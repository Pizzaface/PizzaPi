# Phase 0 — Claude CLI Stdin Protocol Research

## Status: VALIDATED — Multi-turn via stdin works

**Date:** April 2, 2026
**Claude CLI version:** 2.1.78
**Related idea:** [[idea:TPG8Po1q]]

## Key Finding

The Claude CLI supports two distinct invocation modes:

### 1. Query Mode (single-turn, current implementation)
```bash
claude -p "prompt" --output-format stream-json --verbose
```
- Passes prompt as CLI argument
- Stdin is closed immediately
- Process exits after one turn
- This is what Phase 0 wrapper currently uses

### 2. Client Mode (multi-turn, persistent session)
```bash
claude --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio
```
- **Do NOT use `-p`** — stdin is the input channel
- Stdin stays open; write NDJSON messages per turn
- Process persists across multiple turns
- Supports `control_request`/`control_response` for tool approvals
- This is how the official Agent SDK (Python, Go, Elixir) works

## Protocol Details

### Flags Required for Client Mode

| Flag | Purpose |
|------|---------|
| `--output-format stream-json` | NDJSON output on stdout |
| `--input-format stream-json` | NDJSON input on stdin |
| `--verbose` | Full streaming events (message_start, deltas, etc.) |
| `--permission-prompt-tool stdio` | Enables control_request/control_response for tool approvals |
| `--include-partial-messages` | (Optional) More granular streaming deltas |

### Stdin Message Format

All stdin messages are NDJSON (one JSON object per line) with a `type` discriminator field.

#### User Message
```json
{"type": "user", "message": {"role": "user", "content": "Your follow-up prompt"}}
```

#### Control Response (tool approval)
```json
{"type": "control_response", "request_id": "req_abc123", "permission_decision": "allow"}
```

### Stdout Control Request (tool approval)
```json
{"type": "control_request", "request_id": "req_abc123", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "git add -A"}, "tool_use_id": "toolu_xyz"}}
```

## Implications for Go Runner

### Phase 0 (Immediate)
- Switch from Query Mode (`-p`) to Client Mode (stdin) for persistent sessions
- Add `WriteStdin(msg []byte)` method to Runner for sending NDJSON messages
- First stdin message replaces the `-p` prompt
- Session stays alive across multiple turns without process restart

### Phase 1 (Follow-up)
- Implement `control_request` handling for tool approvals
- Map PizzaPi's tool permission system to `control_response` messages
- Add steering/follow-up queues that write to stdin between turns

### Custom Tool Injection
- The `--permission-prompt-tool stdio` flag means tool approvals flow through stdin/stdout
- Custom tools could potentially be injected via `control_response` with modified tool results
- However, the CLI still executes tools internally — we can only approve/deny, not intercept
- True custom tools would require MCP server injection or direct API integration

## Architecture Decision

**Phase 0 keeps Query Mode** for simplicity — one process per turn. The
multi-turn stdin protocol is validated and ready for Phase 1.

**Phase 1 will adopt Client Mode** with persistent sessions:
1. Spawn `claude` with stdin flags, keep process alive
2. Send initial prompt via stdin NDJSON
3. Read streaming output via stdout NDJSON (same parser)
4. Send follow-up messages via stdin for multi-turn
5. Handle `control_request` for tool approvals

This unblocks:
- Steering (inject messages mid-session)
- Follow-up queues (send after turn completes)
- Multi-turn sessions without process restart
- Custom tool approval policies

## Reference

- Community docs: https://udhaykumarbala.github.io/claude-code-parser/protocol/input-messages.html
- Go SDK reference: `github.com/partio-io/claude-agent-sdk-go` (uses client mode)
- Elixir SDK: `ClaudeAgentSDK.Streaming` (persistent sessions via stdin)
- GitHub issue: anthropics/claude-code#24594 (requesting official docs)
- LobeHub skill: feed-claude-cli-agent-protocol (control_request/control_response)
