// ── Session lifecycle handlers ────────────────────────────────────────────────
// Handles register, session_end, exec_result, and disconnect events.

import type { RelaySocketData } from "@pizzapi/protocol";
import { shouldPreserveOnSocketDisconnect } from "../../../health.js";
import {
    registerTuiSession,
    getLocalTuiSocket,
    broadcastToViewers,
    endSharedSession,
    getSessionOwnerToken,
    forgetLocalTuiSocketIfCurrent,
} from "../../sio-registry.js";
import {
    clearPushPendingQuestion,
    deleteRunnerAssociation,
} from "../../sio-state/index.js";
import { socketAckedSeqs } from "./ack-tracker.js";
import { clearThinkingMaps } from "./thinking-tracker.js";
import { forgetViewerGate } from "./viewer-gate.js";
import { pendingChunkedStates, enqueueSessionEvent } from "./event-pipeline.js";
import type { RelaySocket } from "./types.js";
import { getUserPreference, PREF_SUBAGENT_MODEL } from "../../../user-preferences.js";
import { drainPendingDeliveries, drainPendingResponseRelays } from "../../../events/engine.js";
import { createEngineDeps } from "../../../events/transport.js";
import { createLogger } from "@pizzapi/tools";
import { isRedisAdapterRecoverySocket } from "../../../redis-adapter-recovery.js";

const log = createLogger("sio/relay");

export function registerSessionLifecycleHandlers(socket: RelaySocket): void {
    // ── register ─────────────────────────────────────────────────────────
    socket.on("register", async (data) => {
        const cwd = data.cwd ?? "";
        const sessionFile = typeof data.sessionFile === "string" && data.sessionFile ? data.sessionFile : undefined;
        const isEphemeral = data.ephemeral !== false;
        const collabMode = data.collabMode !== false;

        // A registration failure (e.g. ownership-lock timeout while a stale
        // lease from a crashed node is still live) must not escape this async
        // handler: unhandled rejections are fatal, which turned one stuck
        // session into a relay-wide crash loop. Drop the socket instead — the
        // worker reconnects and re-registers once the lock frees up.
        let registration: Awaited<ReturnType<typeof registerTuiSession>>;
        try {
            registration = await registerTuiSession(socket, cwd, {
                sessionId: data.sessionId,
                isEphemeral,
                collabMode,
                sessionName: data.sessionName,
                sessionFile,
                userId: socket.data.userId,
                userName: (socket.data as RelaySocketData & { userName?: string }).userName,
                parentSessionId: data.parentSessionId ?? undefined,
                // Delivery guarantees: the CLI generation that acks session_trigger
                // emissions declares itself here; the trigger transport reads this
                // to wait for receipt confirmation instead of handoff-optimism.
                acksSessionTrigger: data.acksSessionTrigger === true,
            });
        } catch (err) {
            log.error(`register failed for socket ${socket.id} (session ${data.sessionId ?? "new"}) — closing transport so the worker retries:`, err);
            // Close the transport, not socket.disconnect(): a server-initiated
            // disconnect ("io server disconnect") disables client auto-reconnect,
            // which would orphan the worker. A transport close reconnects with
            // backoff and re-registers.
            socket.conn.close();
            return;
        }
        const { sessionId, token, shareUrl, parentSessionId, wasDelinked } = registration;

        // A disconnect may run while registerTuiSession awaits its ownership
        // lock. In that case the disconnect handler had no sessionId to clean
        // up, so remove the just-created transient record here.
        if (!socket.connected) {
            await enqueueSessionEvent(sessionId, async () => {
                await endSharedSession(sessionId, "Session ended", { expectedOwnerToken: token });
            });
            return;
        }

        socket.data.sessionId = sessionId;
        socket.data.token = token;
        socket.data.cwd = cwd;
        if (sessionFile) socket.data.sessionFile = sessionFile;
        socketAckedSeqs.set(socket.id, 0);

        socket.emit("registered", {
            sessionId,
            token,
            shareUrl,
            isEphemeral,
            collabMode,
            parentSessionId,
            // Server wall-clock time — lets the client compute
            // clock offset for accurate epoch-based delink filtering.
            serverTime: Date.now(),
            supportsSessionTriggerAck: true,
            supportsChunkAck: true,
            // Only include wasDelinked when it is true to keep the payload
            // minimal for non-child or non-delinked sessions.
            ...(wasDelinked ? { wasDelinked: true } : {}),
        });

        // Seed the user's subagent default model into the freshly-registered
        // worker — same channel the settings PUT uses for live updates, so no
        // spawn-path env threading is needed.
        const registerUserId = socket.data.userId;
        if (registerUserId) {
            void getUserPreference(registerUserId, PREF_SUBAGENT_MODEL)
                .then((model) => {
                    if (model) (socket as { emit: (ev: string, data: unknown) => void }).emit("subagent_model_update", { model });
                })
                .catch(() => {});
        }

        // Unified event engine (ADR-0002): deliver Events that queued while
        // this session was offline (or during a wake). FIFO by event time.
        // Drains are scoped to the registering owner: durable rows outlive the
        // session's ownership row, so a recycled id must not inherit them.
        const drainOwner = socket.data.userId ?? null;
        void drainPendingDeliveries(sessionId, createEngineDeps(), drainOwner).catch((err) => {
            // Never block registration on the drain; failures retry next time.
            // ponytail: surface via log only — the pending rows survive.
            log.error(`pending-delivery drain failed for ${sessionId}:`, err);
        });
        // Re-relay responses recorded while this session (as an event SOURCE)
        // was unreachable — its waiters are still parked on trigger_response.
        void drainPendingResponseRelays(sessionId, createEngineDeps(), drainOwner).catch((err) => {
            log.error(`pending-response-relay drain failed for ${sessionId}:`, err);
        });
    });

    // ── session_end ──────────────────────────────────────────────────────
    socket.on("session_end", async (data, acknowledge?: (result: { ended: boolean }) => void) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            if (typeof acknowledge === "function") acknowledge({ ended: false });
            return;
        }
        let sharedOwnerToken: string | null;
        try {
            sharedOwnerToken = await getSessionOwnerToken(sessionId);
        } catch {
            log.warn(`session_end for ${socket.id} — Redis ownership lookup failed; skipping teardown`);
            return;
        }
        if (sharedOwnerToken !== socket.data.token) {
            log.info(`session_end for ${socket.id} — stale or unknown owner, skipping teardown`);
            if (typeof acknowledge === "function") acknowledge({ ended: false });
            return;
        }

        // Drain older events first, then perform every cleanup step only after
        // endSharedSession has revalidated ownership under its distributed lock.
        // `killTerminals` is gated on the CLI's explicit `final` flag — NOT on
        // confirmedTerminal, which also fires for reload/new/resume/fork and
        // `/remote reconnect` (same session id re-registers right after). Only
        // a real quit (data.final === true) may kill this session's PTYs.
        let ended = false;
        await enqueueSessionEvent(sessionId, async () => {
            ended = await endSharedSession(sessionId, "Session ended", {
                confirmedTerminal: true,
                killTerminals: data.final === true,
                expectedOwnerToken: socket.data.token,
                onOwnerConfirmed: async () => {
                    clearThinkingMaps(sessionId);
                    forgetViewerGate(sessionId);
                    pendingChunkedStates.delete(sessionId);
                    await clearPushPendingQuestion(sessionId);
                    // Graceful end — delete the durable runner association so it
                    // isn't restored if a new session reuses this ID later.
                    await deleteRunnerAssociation(sessionId);
                },
            });
        });
        if (ended) socket.data.sessionId = undefined;
        socketAckedSeqs.delete(socket.id);
        if (typeof acknowledge === "function") acknowledge({ ended });
    });

    // ── exec_result — forward to viewers ─────────────────────────────────
    socket.on("exec_result", (data) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId) return;
        broadcastToViewers(sessionId, "exec_result", { ...data, sessionId });
    });

    // ── disconnect ───────────────────────────────────────────────────────
    socket.on("disconnect", async (reason) => {
        log.info(`disconnected: ${socket.id} (${reason})`);
        const sessionId = socket.data.sessionId;
        if (sessionId) {
            // Redis adapter recovery intentionally closes the transport so
            // Socket.IO clients reconnect and re-register. Do not run normal
            // disconnect teardown: the worker/runner is still alive.
            if (isRedisAdapterRecoverySocket(socket)) {
                log.info(`redis adapter recovery — preserving session ${sessionId} during forced reconnect`);
                socketAckedSeqs.delete(socket.id);
                // This socket isn't coming back on its own — it was force-closed
                // to make the worker reconnect. If it never does, the map entry
                // must not pin the session as "has a live local socket" forever.
                forgetLocalTuiSocketIfCurrent(sessionId, socket);
                return;
            }

            // Guard 1 (single-node): if a newer socket already re-registered
            // this session on THIS node, don't tear down the new session.
            // registerTuiSession clears our sessionId as a primary guard, but
            // this check is defense-in-depth for any remaining race windows.
            const currentSocket = getLocalTuiSocket(sessionId);
            if (currentSocket && currentSocket !== socket) {
                log.info(`disconnect for ${socket.id} — session ${sessionId} already owned by ${currentSocket.id}, skipping teardown`);
                socketAckedSeqs.delete(socket.id);
                return;
            }

            // Guard 2 (cross-node): a replacement session may have registered
            // on a DIFFERENT node (multi-node relay).  The local socket map
            // cannot see cross-node sockets, so guard 1 is blind to them.
            // Fetch the current connection-owner token from shared (Redis)
            // state: if it differs from this socket's captured token, this
            // socket is stale/superseded — the replacement session owns the
            // session ID now.  Only the matching token may end the session.
            let sharedOwnerToken: string | null;
            try {
                sharedOwnerToken = await getSessionOwnerToken(sessionId);
            } catch {
                log.warn(`disconnect for ${socket.id} — Redis ownership lookup failed; skipping teardown`);
                socketAckedSeqs.delete(socket.id);
                forgetLocalTuiSocketIfCurrent(sessionId, socket);
                return;
            }
            if (sharedOwnerToken !== socket.data.token) {
                log.info(
                    `disconnect for ${socket.id} — stale or unknown owner for session ${sessionId}, skipping teardown`,
                );
                socketAckedSeqs.delete(socket.id);
                forgetLocalTuiSocketIfCurrent(sessionId, socket);
                return;
            }

            // During graceful shutdown (io.close()), Socket.IO disconnects
            // all sockets with reason "server shutting down".  Skip
            // destructive Redis cleanup for those — the TUI worker is
            // still alive and will reconnect to the new server instance.
            if (shouldPreserveOnSocketDisconnect(reason)) {
                log.info(`server shutting down — preserving Redis state for session ${sessionId}`);
                socketAckedSeqs.delete(socket.id);
                forgetLocalTuiSocketIfCurrent(sessionId, socket);
                return;
            }

            // Drain chunk handlers before teardown. The cleanup callback runs
            // only after ownership is revalidated under the same lock that
            // serializes replacement registration.
            await enqueueSessionEvent(sessionId, async () => {
                await endSharedSession(sessionId, "Session ended", {
                    expectedOwnerToken: socket.data.token,
                    onOwnerConfirmed: async () => {
                        clearThinkingMaps(sessionId);
                        forgetViewerGate(sessionId);
                        pendingChunkedStates.delete(sessionId);
                        await clearPushPendingQuestion(sessionId);
                    },
                });
            });
            // NOTE: We intentionally do NOT remove the child from the
            // parent's children set here. Doing so races with delink_children;
            // leaving membership in place lets that path write its delink marker.
        }
        socketAckedSeqs.delete(socket.id);
    });
}
