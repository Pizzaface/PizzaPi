import * as React from "react";

/**
 * Context that provides a callback to toggle an MCP server's enabled/disabled state.
 * This avoids threading the callback through renderContent() and the full message tree.
 *
 * The callback sends an `mcp_toggle_server` remote exec command to the runner,
 * which updates the project's .pizzapi/config.json and reloads MCP.
 */
export type McpToggleHandler = (serverName: string, disabled: boolean) => void;

export const McpToggleContext = React.createContext<McpToggleHandler | null>(null);

export function useMcpToggle(): McpToggleHandler | null {
  return React.useContext(McpToggleContext);
}
