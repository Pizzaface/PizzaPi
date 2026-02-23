import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
  RunnerClientToServerEvents,
  RunnerServerToClientEvents,
  RunnerInterServerEvents,
  RunnerSocketData,
} from "@pizzapi/protocol";

export function registerRunnerNamespace(io: SocketIOServer): void {
  const runner: Namespace<
    RunnerClientToServerEvents,
    RunnerServerToClientEvents,
    RunnerInterServerEvents,
    RunnerSocketData
  > = io.of("/runner");

  runner.on("connection", (socket) => {
    console.log(`[sio/runner] connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[sio/runner] disconnected: ${socket.id} (${reason})`);
    });

    // TODO: Implement event handlers in b8h.5
  });
}
