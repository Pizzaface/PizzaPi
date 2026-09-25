# Local MCP elicitation test server

Use this fixture to exercise PizzaPi's interactive form flow manually.

Add it to `~/.pizzapi/config.json`:

```json
{
  "mcpServers": {
    "elicitation-test": {
      "command": "node",
      "args": ["/absolute/path/to/PizzaPi/packages/cli/src/extensions/mcp/elicitation-test-server.mjs"]
    }
  }
}
```

Reload MCP (`/mcp reload`) or restart PizzaPi, then call `ask_for_name`. The server asks for a name with default `Ada`; try editing, accepting, declining, or canceling. After acceptance it returns a greeting. This uses the 2026-07-28 `server/discover` + MRTR `input_required`/`inputResponses` flow over stdio. No external server or credentials are needed.
