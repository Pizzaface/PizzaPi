export interface McpReloadResult {
  reloaded: number;
  failed: number;
}

export function formatMcpReloadMessage(result: McpReloadResult): string {
  const { reloaded, failed } = result;

  if (reloaded === 0 && failed === 0) {
    return "No active sessions were available to reload.";
  }

  if (reloaded === 0) {
    return `Found ${failed} active session${failed === 1 ? "" : "s"}, but none could be reloaded.`;
  }

  const success = `Reloaded MCP in ${reloaded} active session${reloaded === 1 ? "" : "s"}.`;
  if (failed === 0) return success;
  return `${success} ${failed} session${failed === 1 ? "" : "s"} could not be reloaded.`;
}
