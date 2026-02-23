import type { Server as SocketIOServer } from "socket.io";
import { registerRelayNamespace } from "./relay.js";
import { registerViewerNamespace } from "./viewer.js";
import { registerRunnerNamespace } from "./runner.js";
import { registerTerminalNamespace } from "./terminal.js";
import { registerHubNamespace } from "./hub.js";

export function registerNamespaces(io: SocketIOServer): void {
  registerRelayNamespace(io);
  registerViewerNamespace(io);
  registerRunnerNamespace(io);
  registerTerminalNamespace(io);
  registerHubNamespace(io);
}

// Re-export runner command functions for use by REST API routes
export { sendSkillCommand, sendRunnerCommand } from "./runner.js";
