import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
  ViewerClientToServerEvents,
  ViewerServerToClientEvents,
  ViewerInterServerEvents,
  ViewerSocketData,
} from "@pizzapi/protocol";

export function registerViewerNamespace(io: SocketIOServer): void {
  const viewer: Namespace<
    ViewerClientToServerEvents,
    ViewerServerToClientEvents,
    ViewerInterServerEvents,
    ViewerSocketData
  > = io.of("/viewer");

  viewer.on("connection", (socket) => {
    console.log(`[sio/viewer] connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[sio/viewer] disconnected: ${socket.id} (${reason})`);
    });

    // TODO: Implement event handlers in b8h.5
  });
}
