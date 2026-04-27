// ── Parent-child lifecycle handlers ──────────────────────────────────────────
// Handles cleanup_child_session, delink_children, and delink_own_parent events.

import type { Server as SocketIOServer } from "socket.io";
import {
    getSharedSession,
    emitToRelaySession,
    emitToRelaySessionAwaitingAck,
    emitToRunner,
    endSharedSession,
} from "../../sio-registry.js";
import {
    removeChildSession,
    removeChildren,
    addPendingParentDelinkChildren,
    getChildSessions,
    getPendingParentDelinkChildren,
    removePendingParentDelinkChild,
    getSession,
    markChildAsDelinked,
    isChildDelinked,
    isChildOfParent,
    clearParentSessionId,
} from "../../sio-state/index.js";
import type { RelaySocket } from "./types.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/relay");

/**
 * Count only *live* linked children for a parent session.
 *
 * The Redis children set intentionally retains entries for disconnected or
 * ended children (so delink_children can still reach them later).  For the
 * auto-close decision we must not count those stale entries — only children
 * whose session hash still exists AND still points at this parent.
 */
export async function countLinkedChildrenForParent(
    parentSessionId: string,
    deps: {
        getChildSessions?: typeof getChildSessions;
        getSession?: typeof getSession;
    } = {},
): Promise<number> {
    const _getChildSessions = deps.getChildSessions ?? getChildSessions;
    const _getSession = deps.getSession ?? getSession;

    const childIds = await _getChildSessions(parentSessionId);
    if (childIds.length === 0) return 0;

    // Check each child in parallel — only count those still alive and linked.
    const checks = await Promise.all(
        childIds.map(async (childId) => {
            const session = await _getSession(childId);
            if (!session) return false; // session hash gone — child already ended
            // Child still linked if parentSessionId or linkedParentId points here.
            return (
                session.parentSessionId === parentSessionId ||
                (session as any).linkedParentId === parentSessionId
            );
        }),
    );
    return checks.filter(Boolean).length;
}

export function registerChildLifecycleHandlers(socket: RelaySocket, io: SocketIOServer): void {
    socket.on("get_linked_child_count", async (data, ack) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
            return;
        }

        try {
            const count = await countLinkedChildrenForParent(sessionId);
            if (typeof ack === "function") ack({ ok: true, count });
        } catch (err: any) {
            log.error(`get_linked_child_count failed for parent=${sessionId}:`, err);
            if (typeof ack === "function") ack({ ok: false, error: err?.message ?? "Internal error" });
        }
    });

    // ── cleanup_child_session — parent requests child teardown on ack ────
    socket.on("cleanup_child_session", async (data, ack) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
            return;
        }

        const childSessionId = data?.childSessionId;
        if (!childSessionId) {
            socket.emit("error", { message: "cleanup_child_session requires childSessionId" });
            if (typeof ack === "function") ack({ ok: false, error: "cleanup_child_session requires childSessionId" });
            return;
        }

        // Validate the sender is the parent of the target child session
        const childSession = await getSharedSession(childSessionId);
        if (!childSession) {
            // Child already gone — nothing to clean up (idempotent)
            if (typeof ack === "function") ack({ ok: true });
            return;
        }

        // Same fallback as trigger_response: when the child's parentSessionId
        // was cleared during a transient-offline reconnect, check set membership.
        const isParentOfChild = childSession.parentSessionId === sessionId
            || await isChildOfParent(sessionId, childSessionId);
        if (!isParentOfChild) {
            socket.emit("error", { message: "Sender is not the parent of the target session (linked relationship is broken or stale)" });
            if (typeof ack === "function") ack({ ok: false, error: "Sender is not the parent of the target session (linked relationship is broken or stale)" });
            return;
        }

        // Validate same user ownership
        const parentSession = await getSharedSession(sessionId);
        if (!parentSession?.userId || parentSession.userId !== childSession.userId) {
            socket.emit("error", { message: "Target session belongs to a different user" });
            if (typeof ack === "function") ack({ ok: false, error: "Target session belongs to a different user" });
            return;
        }

        log.info(`cleanup_child_session: parent=${sessionId} child=${childSessionId}`);

        try {
            // Terminate the child process via two complementary paths:
            //
            // 1. kill_session → runner (cluster-wide via emitToRunner):
            //    sends SIGTERM to the OS process.  Reaches runners on any
            //    cluster node through the Redis adapter.
            if (childSession.runnerId) {
                emitToRunner(childSession.runnerId, "kill_session", { sessionId: childSessionId });
            }

            // 2. exec end_session → child relay socket (cluster-wide via Redis
            //    adapter room broadcast).  Reaches the child on any node and
            //    causes it to clear its follow-up grace timer and shut down
            //    cleanly.  If the runner already sent SIGTERM in step 1 the
            //    exec arrives to an already-exiting worker (benign no-op).
            emitToRelaySession(childSessionId, "exec", {
                id: `cleanup-${childSessionId}-${Date.now()}`,
                command: "end_session",
            });

            // ⚡ Bolt: Fast socket presence check via adapter.sockets() avoids expensive cluster-wide network overhead of fetchSockets()
            const relaySockets = await io.of("/relay").adapter.sockets(new Set([`session:${childSessionId}`]));
            const hasRelayRecipient = relaySockets instanceof Set ? relaySockets.size > 0 : (relaySockets as any[]).length > 0;

            // Clean up child-index entry
            void removeChildSession(sessionId, childSessionId);

            if (!hasRelayRecipient) {
                // No relay socket is currently joined for this child anywhere in
                // the cluster, so there is no disconnect handler left to finish
                // cleanup. Complete teardown now so acknowledged children don't
                // linger in Redis/sidebar until the orphan sweeper runs.
                await endSharedSession(childSessionId, "Parent acknowledged completion");
                if (typeof ack === "function") ack({ ok: true });
                return;
            }

            // Do NOT call endSharedSession here when a relay recipient exists.
            // The child will disconnect momentarily (from the SIGTERM or exec
            // above), and its disconnect handler on whichever node hosts the
            // child's relay socket will call endSharedSession there — where the
            // correct local runner socket is available for adopted-session
            // cleanup. Calling it here first would delete the Redis record
            // before that node can process the disconnect, turning its
            // endSharedSession into a no-op and leaving adopted-session entries
            // stranded in runningSessions on the remote runner.

            if (typeof ack === "function") ack({ ok: true });
        } catch (err: any) {
            log.error(`cleanup_child_session failed: parent=${sessionId} child=${childSessionId}`, err);
            if (typeof ack === "function") ack({ ok: false, error: err?.message ?? "Internal error" });
        }
    });

    // ── delink_children — parent severs all child links (e.g. on /new) ─
    socket.on("delink_children", async (data, ack?: (result: { ok: boolean; error?: string }) => void) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
            return;
        }

        // Optional epoch (ms): when provided, only delink children whose
        // startedAt is before this timestamp.  Used by deferred delinks
        // (sent on reconnect after /new while disconnected) to avoid
        // inadvertently delinking children spawned during the disconnect
        // window.
        const epoch: number | undefined =
            typeof data.epoch === "number" && data.epoch > 0 ? data.epoch : undefined;

        log.info(`delink_children: parent=${sessionId}${epoch ? ` epoch=${new Date(epoch).toISOString()}` : ""}`);

        try {
            // Snapshot current children plus any children whose
            // parent_delinked delivery previously timed out. The pending
            // retry set preserves recipients across delink_children retries
            // even after we have already removed them from the membership set.
            const [currentChildIds, pendingRetryChildIds] = await Promise.all([
                getChildSessions(sessionId),
                getPendingParentDelinkChildren(sessionId),
            ]);
            let childIds = Array.from(new Set([...currentChildIds, ...pendingRetryChildIds]));

            // If an epoch was provided, filter out children that registered
            // after the epoch — they belong to the new conversation and must
            // not be delinked. However, children with existing delink markers
            // are stale and should be included even if their startedAt > epoch
            // (this handles the case where a stale child reconnected and got a
            // fresh startedAt timestamp).
            if (epoch && childIds.length > 0) {
                const filtered: string[] = [];
                for (const childId of childIds) {
                    const childSession = await getSession(childId);
                    if (!childSession?.startedAt) {
                        // No session data — conservative: include it
                        filtered.push(childId);
                        continue;
                    }
                    const startedAtMs = new Date(childSession.startedAt).getTime();
                    if (startedAtMs <= epoch) {
                        filtered.push(childId);
                    } else {
                        // Child started after epoch, but check if it already has a delink marker.
                        // If it does, it's a stale child that reconnected and should be delinked
                        // regardless of its fresh startedAt timestamp.
                        const hasDelinkMarker = await isChildDelinked(childId);
                        if (hasDelinkMarker) {
                            filtered.push(childId);
                            log.info(`delink_children: including child ${childId} (startedAt > epoch but has delink marker)`);
                        } else {
                            log.info(`delink_children: skipping child ${childId} (startedAt=${childSession.startedAt} > epoch)`);
                        }
                    }
                }
                childIds = filtered;
            }

            // Write delink markers BEFORE clearing the membership set. This
            // closes a race window: if a child reconnects between the snapshot
            // and the clear, registerTuiSession's isChildDelinked() check will
            // already find the marker and refuse to re-link. If we cleared
            // first and wrote markers second, a reconnecting child could slip
            // through before its marker exists.
            for (const childId of childIds) {
                // Store the parent session ID in the marker so that
                // addChildSession can scrub the child from this parent's
                // pending-delink retry set when the child is re-linked elsewhere.
                await markChildAsDelinked(childId, sessionId);
            }
            await addPendingParentDelinkChildren(sessionId, childIds);

            // Remove only the snapshotted children from the membership set.
            // Using removeChildren() instead of clearAllChildren() avoids a
            // race: if the parent spawns a new child between the snapshot and
            // this removal, the new child's membership is preserved.
            await removeChildren(sessionId, childIds);

            // Notify each connected child that their parent is gone.
            // This lets children cancel any pending triggers awaiting a response.
            //
            // NOTE: We intentionally do NOT clear parentSessionId in Redis here.
            // Doing so races with any in-flight trigger_response(cancel) messages
            // that clearAndCancelPendingTriggers() emitted just before this event.
            // The trigger_response handler checks targetSession.parentSessionId; if
            // we clear it concurrently, the check fails with "Sender is not the
            // parent" and the child is left blocked until its 5-minute timeout.
            //
            // Instead, parentSessionId is cleaned up lazily: registerTuiSession
            // checks isChildDelinked() on reconnect and clears the stale field
            // then (see sio-registry.ts).  For connected children, the parent_delinked
            // event causes rctx.parentSessionId = null so reconnects won't re-link.
            // For offline children (who never received parent_delinked), the marker
            // we just wrote above prevents re-link.
            for (const childId of childIds) {
                const payload = { parentSessionId: sessionId };
                const delivery = await emitToRelaySessionAwaitingAck(childId, "parent_delinked", payload);
                if (delivery.hadListeners && !delivery.acked) {
                    throw new Error(`parent_delinked delivery was not confirmed for child ${childId}`);
                }
                // Offline children are safe to clear from the retry set too:
                // their delink marker will prevent re-linking on reconnect.
                await removePendingParentDelinkChild(sessionId, childId);
            }

            // Acknowledge that the delink completed only after every
            // connected child has confirmed parent_delinked delivery. The
            // client uses this to clear its pendingDelink retry guard —
            // until the ack arrives, it keeps blocking stale child
            // session_message / session_trigger traffic from reaching the
            // new conversation.
            if (typeof ack === "function") ack({ ok: true });
        } catch (err) {
            log.error(`delink_children failed for parent=${sessionId}:`, err);
            // Always nack so the client can clear its pendingDelink guard
            // and retry on reconnect rather than latching permanently.
            if (typeof ack === "function") ack({ ok: false, error: String(err) });
        }
    });

    // ── delink_own_parent — child severs its own parent link (e.g. on /new) ─
    // When a child session starts /new, it clears its local parent link
    // but the server still has the association. This event lets the child
    // tell the server to remove itself from the old parent's children set
    // and clear the parentSessionId on its own Redis session hash.
    socket.on("delink_own_parent", async (data, ack: ((result: { ok: boolean; error?: string }) => void) | undefined) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
            return;
        }

        const session = await getSharedSession(sessionId);
        const parentId = session?.parentSessionId;
        if (!parentId) {
            // parentSessionId is already cleared in Redis (e.g. the child
            // ran /new while the relay socket was down, so
            // registerTuiSession wrote null before this event arrived).
            // If the client supplied the old parent ID it captured before
            // clearing rctx.parentSessionId, use it to scrub the stale
            // children-set entry that the disconnect path deliberately
            // left behind to avoid a /new race window.
            const oldParentId = typeof data?.oldParentId === "string" ? data.oldParentId : null;
            if (oldParentId) {
                log.info(
                    `delink_own_parent: child=${sessionId} parentSessionId already cleared — removing stale child entry from parent=${oldParentId}`,
                );
                try {
                    await removeChildSession(oldParentId, sessionId);
                } catch (err) {
                    log.error("delink_own_parent: failed to remove stale child entry:", err);
                    if (typeof ack === "function") ack({ ok: false, error: err instanceof Error ? err.message : String(err) });
                    return;
                }
            }
            // parentSessionId was already null in Redis, but linkedParentId
            // may still be set (preserved when the parent was offline during
            // the child's reconnect). Clear both fields so push-notification
            // suppression correctly stops for this now-independent session.
            try {
                await clearParentSessionId(sessionId);
            } catch (err) {
                log.error("delink_own_parent: failed to clear linkedParentId:", err);
                // Non-fatal: suppression will self-correct once the membership set expires.
            }
            // Already delinked or never linked — confirm success so the
            // client stops retrying.
            if (typeof ack === "function") ack({ ok: true });
            return;
        }

        log.info(`delink_own_parent: child=${sessionId} parent=${parentId}`);

        // Clear our own parentSessionId FIRST — this closes the race
        // window where a stale ack/followUp/cleanup_child_session from
        // the old parent could still see parentSessionId === oldParent
        // and authorize operations against this now-independent session.
        // Then remove ourselves from the parent's children set.
        // Both writes are atomic enough for our purposes; if either
        // throws, ack failure so the client retries on next reconnect.
        try {
            await clearParentSessionId(sessionId);
            await removeChildSession(parentId, sessionId);
        } catch (err) {
            log.error("delink_own_parent: Redis write failed:", err);
            if (typeof ack === "function") ack({ ok: false, error: err instanceof Error ? err.message : String(err) });
            return;
        }

        // Acknowledge success so the client can clear its retry flag.
        if (typeof ack === "function") ack({ ok: true });
    });
}
