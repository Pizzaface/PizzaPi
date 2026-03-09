import type { RelayContext } from "./mcp-oauth.js";

export interface McpBridge {
  status: () => unknown;
  reload: () => Promise<unknown>;
  /** Set the relay context for OAuth providers (called by remote extension). */
  setRelayContext?: (ctx: RelayContext | null) => void;
  /** Deliver an OAuth callback code from the server (called by remote extension). */
  deliverOAuthCallback?: (nonce: string, code: string) => void;
}

let activeBridge: McpBridge | null = null;

export function setMcpBridge(bridge: McpBridge | null) {
  activeBridge = bridge;
}

export function getMcpBridge(): McpBridge | null {
  return activeBridge;
}
