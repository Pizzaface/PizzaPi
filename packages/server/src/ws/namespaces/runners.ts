// ============================================================================
// /runners namespace — Browser runner feed (read-only for clients)
//
// On connection: send initial runner list snapshot.
// Clients receive runner_added / runner_removed / runner_updated events
// pushed by sio-registry when the runner daemon connects or changes.
// ============================================================================

import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
    RunnersClientToServerEvents,
    RunnersServerToClientEvents,
    RunnersInterServerEvents,
    RunnersSocketData,
} from "@pizzapi/protocol";
import { sessionCookieAuthMiddleware } from "./auth.js";
import { getRunners, runnersUserRoom } from "../sio-registry.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/runners");

export function registerRunnersNamespace(io: SocketIOServer): void {
    const runners: Namespace<
        RunnersClientToServerEvents,
        RunnersServerToClientEvents,
        RunnersInterServerEvents,
        RunnersSocketData
    > = io.of("/runners");

    // Auth: validate session cookie from handshake (same as /hub)
    runners.use(sessionCookieAuthMiddleware() as Parameters<typeof runners.use>[0]);

    runners.on("connection", async (socket) => {
        const userId = socket.data.userId ?? "";

        log.info(`connected: ${socket.id} userId=${userId}`);

        // Join per-user room so broadcasts are user-scoped
        await socket.join(runnersUserRoom(userId));

        // Send initial runner list for this user
        const initialRunners = await getRunners(userId);
        socket.emit("runners", { runners: initialRunners });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", (reason) => {
            log.info(`disconnected: ${socket.id} (${reason})`);
            // Socket.IO automatically removes sockets from rooms on disconnect
        });
    });
}
