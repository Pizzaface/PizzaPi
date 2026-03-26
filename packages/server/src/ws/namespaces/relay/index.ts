// ============================================================================
// /relay namespace — TUI (CLI agent) ↔ Server
//
// Handles TUI registration, agent event pipeline with thinking-duration
// tracking, session lifecycle, inter-session messaging, and push notifications.
//
// This module is the entry point; it creates the namespace, applies auth
// middleware, and wires socket handlers from focused sub-modules.
// ============================================================================

import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
    RelayClientToServerEvents,
    RelayServerToClientEvents,
    RelayInterServerEvents,
    RelaySocketData,
} from "@pizzapi/protocol";
import { apiKeyAuthMiddleware } from "../auth.js";
import { registerEventHandler } from "./event-pipeline.js";
import { registerSessionLifecycleHandlers } from "./session-lifecycle.js";
import { registerMessagingHandlers } from "./messaging.js";
import { registerChildLifecycleHandlers } from "./child-lifecycle.js";
import { createLogger } from "@pizzapi/tools";

// Re-export for viewer.ts compatibility
export { getPendingChunkedSnapshot } from "./event-pipeline.js";

const log = createLogger("sio/relay");

export function registerRelayNamespace(io: SocketIOServer): void {
    const relay: Namespace<
        RelayClientToServerEvents,
        RelayServerToClientEvents,
        RelayInterServerEvents,
        RelaySocketData
    > = io.of("/relay");

    // Auth: validate API key from handshake
    relay.use(apiKeyAuthMiddleware() as Parameters<typeof relay.use>[0]);

    relay.on("connection", (socket) => {
        log.info(`connected: ${socket.id}`);

        registerSessionLifecycleHandlers(socket);
        registerEventHandler(socket);
        registerMessagingHandlers(socket);
        registerChildLifecycleHandlers(socket, io);
    });
}
