import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
  TerminalClientToServerEvents,
  TerminalServerToClientEvents,
  TerminalInterServerEvents,
  TerminalSocketData,
} from "@pizzapi/protocol";

export function registerTerminalNamespace(io: SocketIOServer): void {
  const terminal: Namespace<
    TerminalClientToServerEvents,
    TerminalServerToClientEvents,
    TerminalInterServerEvents,
    TerminalSocketData
  > = io.of("/terminal");

  terminal.on("connection", (socket) => {
    console.log(`[sio/terminal] connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[sio/terminal] disconnected: ${socket.id} (${reason})`);
    });

    // TODO: Implement event handlers in b8h.5
  });
}
