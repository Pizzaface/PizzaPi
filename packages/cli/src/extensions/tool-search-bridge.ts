export interface ToolSearchToolStatus {
  name: string;
  description: string;
  parameterNames: string[];
  charCount: number;
  serverName?: string;
}

export interface ToolSearchSnapshot {
  active: boolean;
  deferredTools: ToolSearchToolStatus[];
  loadedOnDemandTools: ToolSearchToolStatus[];
}

export interface ToolSearchBridge {
  status: () => ToolSearchSnapshot;
}

let activeBridge: ToolSearchBridge | null = null;

export function setToolSearchBridge(bridge: ToolSearchBridge | null) {
  activeBridge = bridge;
}

export function getToolSearchBridge(): ToolSearchBridge | null {
  return activeBridge;
}
