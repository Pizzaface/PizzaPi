# MCP Deferral Status Design

**Goal:** Make `/mcp` the source of truth for MCP status by explicitly representing loaded, deferred/unloaded, and disabled state for both servers and tools across CLI and web UI surfaces.

## Problem

Today the `/mcp` snapshot reports loaded tools and disabled servers, but Tool Search deferral state lives separately in `tool-search.ts`. As a result, MCP status surfaces can silently omit deferred/unloaded tools and servers.

## Design

### Source of truth

- Extend the shared MCP snapshot returned by `mcpExtension`.
- Add normalized per-server and per-tool state into the snapshot.
- Read live Tool Search state through a shared bridge/helper instead of inferring it in the UI.

### States

Tools should report explicit state:
- `loaded`
- `deferred`
- `loaded_on_demand` (when applicable)
- `disabled` (server-derived)

Servers should report explicit state:
- `loaded`
- `deferred`
- `disabled`
- `partial` when a server has a mix of loaded and deferred tools

### Affected surfaces

- `/mcp` text output
- remote `/mcp` exec payload
- session viewer MCP command card
- any other UI surface already consuming the same MCP status payload

### UI behavior

- Deferred/unloaded servers stay visible instead of disappearing.
- Disabled remains visually distinct from deferred/unloaded.
- Tool chips/badges show state rather than implying that visibility equals loaded.

### Verification

- CLI tests for normalized snapshot state and `/mcp` output
- Tool Search lifecycle regression coverage for deferred ↔ loaded transitions
- UI tests for rendering loaded, deferred/unloaded, partial, and disabled states
