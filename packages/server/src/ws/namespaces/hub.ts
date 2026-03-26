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
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/hub");

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

        log.info(`connected: ${socket.id} userId=${userId}`);

        // Join hub room (filtered by user)
        await addHubClient(socket, userId);

        // Send initial session list for this user
        const sessions = await getSessions(userId);
        socket.emit("sessions", { sessions });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            log.info(`disconnected: ${socket.id} (${reason})`);
            await removeHubClient(socket, userId);
        });

        // ── Session meta subscription ─────────────────────────────────────────────
        socket.on("subscribe_session_meta", async (data: unknown) => {
          if (!data || typeof (data as Record<string, unknown>).sessionId !== "string") return;
          const sessionId = (data as { sessionId: string }).sessionId;

          // Validate ownership — only the session owner may subscribe.
          // Distinguish "session is not live yet / no longer live" from an
          // actual cross-user subscription attempt so restart-time reconnect
          // races don't look like auth failures in the logs.
          const session = await getSession(sessionId);
          if (!session) {
            log.info(`subscribe_session_meta: session missing userId=${userId} sessionId=${sessionId}`);
            return;
          }
          if (session.userId !== userId) {
            log.warn(`subscribe_session_meta: unauthorized userId=${userId} sessionId=${sessionId}`);
            return;
          }

          // Read state, join room, then re-read to avoid a narrow race window:
          //
          // Between the initial read and the join, a relay meta_event can:
          //   1. Write version N+1 to Redis AND broadcast to the room.
          //   2. Since socket isn't in the room yet, it misses the broadcast.
          //   3. We join and send stale snapshot(N) — client never sees N+1.
          //
          // The re-read after join closes this window: if anything wrote N+1
          // during the join I/O, the second read picks it up. If a write races
          // the second read, the client is already subscribed and will receive
          // the meta_event(N+1) through the room — so the snapshot can be stale
          // by at most the in-flight write, which the room broadcast corrects.
          const stateBeforeJoin = await getSessionMetaState(sessionId);
          await socket.join(sessionMetaRoom(sessionId));
          // Re-read after join to capture any write that raced the join
          const state = await getSessionMetaState(sessionId) ?? stateBeforeJoin;
          socket.emit("state_snapshot", { sessionId, state });

          log.info(`meta subscribe: ${socket.id} → session ${sessionId}`);
        });

        socket.on("unsubscribe_session_meta", async (data: unknown) => {
          if (!data || typeof (data as Record<string, unknown>).sessionId !== "string") return;
          const sessionId = (data as { sessionId: string }).sessionId;
          socket.leave(sessionMetaRoom(sessionId));
          log.info(`meta unsubscribe: ${socket.id} ← session ${sessionId}`);
        });
    });
}
