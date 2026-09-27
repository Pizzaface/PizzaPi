# Local MCP URL elicitation test server

Use this fixture to exercise PizzaPi's URL-mode consent flow manually. It never asks for real credentials: the "external" page is a local HTTP page with a **Complete** link.

Add it to `~/.pizzapi/config.json`:

```json
{
  "mcpServers": {
    "elicitation-url-test": {
      "command": "bun",
      "args": ["/absolute/path/to/PizzaPi/packages/cli/src/extensions/mcp/elicitation-url-test-server.mjs"]
    }
  }
}
```

Reload MCP (`/mcp reload`) or restart PizzaPi, then call `connect_account`:

1. A consent card shows the server name, message, host `127.0.0.1`, the full `http://127.0.0.1:<port>/connect?flow=...` URL, and an "unencrypted http" warning. Nothing is opened yet.
2. **Open in browser** opens the page in a new tab and reports `accept`. The server answers with a state-only `input_required`, so PizzaPi shows **Retry / Cancel**.
3. Click **Complete** on the page, return, choose **Retry**: the tool returns "Account connected."
4. Retry before completing → another Retry/Cancel card; Cancel → the tool call fails with a cancellation error and nothing retries.
5. `connect_account` with `{"repeatUrl": true}` makes the server re-send the URL each round; PizzaPi shows **Retry / Open again / Decline / Cancel** instead of a fresh consent card.

**Limitation:** the page is served on `127.0.0.1` of the machine running the MCP worker. Open the link in a browser on that same machine; a phone or remote browser cannot reach it, so completing the flow from the mobile app is not supported with this fixture.

In the TUI the same text is shown but no link is opened; copy the URL into a browser yourself. The port is random unless `PIZZAPI_ELICITATION_URL_PORT` is set.
