export interface McpBridge {
  status: () => unknown;
  reload: () => Promise<unknown>;
}

let activeBridge: McpBridge | null = null;

export function setMcpBridge(bridge: McpBridge | null) {
  activeBridge = bridge;
}

export function getMcpBridge(): McpBridge | null {
  return activeBridge;
}
