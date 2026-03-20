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
  callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<McpCallToolResult>;
  close(): void;
};

/**
 * Protocol version we advertise during the MCP initialize handshake.
 * Using the 2025-03-26 spec (widely supported); servers may negotiate down.
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** Versions we accept from the server in its InitializeResult. */
export const MCP_SUPPORTED_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]);

/** Client info sent during the initialize handshake. */
export const MCP_CLIENT_INFO = { name: "pizzapi", version: "1.0.0" };

/** Type guard for plain objects (used by JSON-RPC response parsers). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
