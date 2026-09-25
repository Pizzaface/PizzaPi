/**
 * Shared types, protocol constants, and utility helpers for the MCP client layer.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Json;
};

export type McpListToolsResult = { tools: McpTool[] };

export type McpCallToolResult = {
  content?: unknown;
  isError?: boolean;
  // Some MCP servers return structured content blocks.
  // We'll just forward as-is.
};

export type McpElicitationResult = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type McpElicitationHandler = ((params: unknown, signal?: AbortSignal) => Promise<McpElicitationResult>) & {
  /** Manual control for state-only MRTR rounds (server waiting out of band). Absent = fail closed. */
  resume?: (signal?: AbortSignal) => Promise<"retry" | "cancel">;
};

/** Advertised only when a handler exists; both modes need a human surface. */
export const MCP_ELICITATION_CAPABILITY = { elicitation: { form: {}, url: {} } };

export type McpClient = {
  name: string;
  /**
   * Perform the MCP initialize handshake (and any OAuth if needed).
   * Separating this from listTools() allows callers to complete auth
   * without being constrained by tool-listing timeouts.
   *
   * An optional AbortSignal can be passed to cancel the in-flight
   * handshake request (e.g. when an init timeout fires).
   */
  initialize(signal?: AbortSignal): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(toolName: string, args: unknown, signal?: AbortSignal, onElicitation?: McpElicitationHandler): Promise<McpCallToolResult>;
  close(): void;
};

/** Preferred modern version and the unchanged legacy handshake version. */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** Versions we accept from a legacy server in its InitializeResult. */
export const MCP_SUPPORTED_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]);

export const MCP_MODERN_ERROR_CODES = new Set([-32022, -32021, -32020]);

export function modernRequestMeta(capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": capabilities,
  };
}

/** Client info sent during the initialize handshake. */
export const MCP_CLIENT_INFO = { name: "pizzapi", version: "1.0.0" };

/** Type guard for plain objects (used by JSON-RPC response parsers). Re-exported from the protocol package. */
export { isRecord } from "@pizzapi/protocol";
