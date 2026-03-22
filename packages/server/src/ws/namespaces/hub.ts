// ============================================================================
// /hub namespace — Session list feed (read-only for clients)
//
// Hub is a read-only feed. Clients connect to receive the live session list
// and status updates. All broadcasts are triggered by sio-registry when
// sessions are added/removed/updated.
// ============================================================================

import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
    HubClientToServerEvents,
    HubServerToClientEvents,
    HubInterServerEvents,
    HubSocketData,
} from "@pizzapi/protocol";
import { sessionCookieAuthMiddleware } from "./auth.js";
import {
    addHubClient,
    removeHubClient,
    getSessions,
} from "../sio-registry.js";
import { getSession } from "../sio-state.js";
import { getSessionMetaState, sessionMetaRoom } from "../sio-registry/meta.js";

export function registerHubNamespace(io: SocketIOServer): void {
    const hub: Namespace<
        HubClientToServerEvents,
        HubServerToClientEvents,
        HubInterServerEvents,
        HubSocketData
    > = io.of("/hub");

    // Auth: validate session cookie from handshake
    hub.use(sessionCookieAuthMiddleware() as Parameters<typeof hub.use>[0]);

    hub.on("connection", async (socket) => {
        const userId = socket.data.userId ?? "";

        console.log(`[sio/hub] connected: ${socket.id} userId=${userId}`);

        // Join hub room (filtered by user)
        await addHubClient(socket, userId);

        // Send initial session list for this user
        const sessions = await getSessions(userId);
        socket.emit("sessions", { sessions });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            console.log(`[sio/hub] disconnected: ${socket.id} (${reason})`);
            await removeHubClient(socket, userId);
        });

        // ── Session meta subscription ─────────────────────────────────────────────
        socket.on("subscribe_session_meta", async (data: unknown) => {
          if (!data || typeof (data as Record<string, unknown>).sessionId !== "string") return;
          const sessionId = (data as { sessionId: string }).sessionId;

          // Validate ownership — only the session owner may subscribe
          const session = await getSession(sessionId);
          if (!session || session.userId !== userId) {
            console.warn(`[sio/hub] subscribe_session_meta: unauthorized userId=${userId} sessionId=${sessionId}`);
            return;
          }

          // Join room FIRST so any meta_event broadcast after join arrives before snapshot
          await socket.join(sessionMetaRoom(sessionId));

          // Send current state immediately
          const state = await getSessionMetaState(sessionId);
          socket.emit("state_snapshot", { sessionId, state });

          console.log(`[sio/hub] meta subscribe: ${socket.id} → session ${sessionId}`);
        });

        socket.on("unsubscribe_session_meta", async (data: unknown) => {
          if (!data || typeof (data as Record<string, unknown>).sessionId !== "string") return;
          const sessionId = (data as { sessionId: string }).sessionId;
          socket.leave(sessionMetaRoom(sessionId));
          console.log(`[sio/hub] meta unsubscribe: ${socket.id} ← session ${sessionId}`);
        });
    });
}
