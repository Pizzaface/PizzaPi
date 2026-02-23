import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
  RelayClientToServerEvents,
  RelayServerToClientEvents,
  RelayInterServerEvents,
  RelaySocketData,
} from "@pizzapi/protocol";

export function registerRelayNamespace(io: SocketIOServer): void {
  const relay: Namespace<
    RelayClientToServerEvents,
    RelayServerToClientEvents,
    RelayInterServerEvents,
    RelaySocketData
  > = io.of("/relay");

  relay.on("connection", (socket) => {
    console.log(`[sio/relay] connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[sio/relay] disconnected: ${socket.id} (${reason})`);
    });

    // TODO: Implement event handlers in b8h.5
  });
}
