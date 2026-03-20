/**
 * MCP client layer — barrel re-export.
 *
 * All public API is preserved here for backward compatibility with existing
 * importers (`mcp-extension.ts`, `mcp.test.ts`, etc.). The implementation
 * has been split into focused modules:
 *
 *  - mcp-types.ts          — shared types, protocol constants, isRecord helper
 *  - mcp-tool-naming.ts    — collision-safe tool name allocation
 *  - mcp-transport-stdio.ts — STDIO transport (child-process MCP servers)
 *  - mcp-transport-http.ts  — HTTP + Streamable HTTP transports (+ OAuth)
 *  - mcp-registry.ts        — client factory, OAuth lifecycle, tool registration
 */

export {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_CLIENT_INFO,
  isRecord,
  type Json,
  type McpTool,
  type McpListToolsResult,
  type McpCallToolResult,
  type McpClient,
} from "./mcp-types.js";

export { allocateProviderSafeToolName } from "./mcp-tool-naming.js";

export { createStdioMcpClient } from "./mcp-transport-stdio.js";

export {
  isGitHubHost,
  createHttpMcpClient,
  createStreamableMcpClient,
} from "./mcp-transport-http.js";

export {
  type McpConfig,
  type McpServerInitResult,
  type McpRegistrationResult,
  setDeferOAuthRelayWaitTimeoutUntilAnchor,
  markOAuthRelayWaitAnchorReady,
  getOAuthProviders,
  createMcpClientsFromConfig,
  registerMcpTools,
} from "./mcp-registry.js";
