import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
  HubClientToServerEvents,
  HubServerToClientEvents,
  HubInterServerEvents,
  HubSocketData,
} from "@pizzapi/protocol";

export function registerHubNamespace(io: SocketIOServer): void {
  const hub: Namespace<
    HubClientToServerEvents,
    HubServerToClientEvents,
    HubInterServerEvents,
    HubSocketData
  > = io.of("/hub");

  hub.on("connection", (socket) => {
    console.log(`[sio/hub] connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[sio/hub] disconnected: ${socket.id} (${reason})`);
    });

    // TODO: Implement event handlers in b8h.5
  });
}
