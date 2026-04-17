import type { Server as SocketIOServer } from "socket.io";
import type { AuthContext } from "../../auth.js";
import { registerRelayNamespace } from "./relay/index.js";
import { registerViewerNamespace } from "./viewer.js";
import { registerRunnerNamespace } from "./runner.js";
import { registerTerminalNamespace } from "./terminal.js";
import { registerHubNamespace } from "./hub.js";
import { registerRunnersNamespace } from "./runners.js";

export function registerNamespaces(io: SocketIOServer, context: AuthContext): void {
  registerRelayNamespace(io, context);
  registerViewerNamespace(io, context);
  registerRunnerNamespace(io, context);
  registerTerminalNamespace(io, context);
  registerHubNamespace(io, context);
  registerRunnersNamespace(io, context);
}

export { sendSkillCommand, sendAgentCommand, sendRunnerCommand } from "./runner.js";
