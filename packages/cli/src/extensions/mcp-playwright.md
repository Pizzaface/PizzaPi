# Playwright MCP

To enable Playwright MCP tools in `pizzapi`, add this to your config:

`~/.pizzapi/config.json` (or `<project>/.pizzapi/config.json`)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

This will register tools with names like:

- `mcp_playwright_<tool>`

(Exact tool list depends on the MCP server.)
