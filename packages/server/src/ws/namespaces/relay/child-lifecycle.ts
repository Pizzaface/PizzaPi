// ── Parent-child lifecycle handlers ──────────────────────────────────────────
// Handles cleanup_child_session, delink_children, and delink_own_parent events.

import type { Server as SocketIOServer } from "socket.io";
import {
    getSharedSessionSummary,
    emitToRelaySession,
    emitToRelaySessionAwaitingAck,
    emitToRunner,
    endSharedSession,
    countSocketsInRoomCluster,
} from "../../sio-registry.js";
import {
    removeChildSession,
    removeChildren,
    addPendingParentDelinkChildren,
    getChildSessions,
    getPendingParentDelinkChildren,
    removePendingParentDelinkChild,
    getSessionSummary,
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
        // Summary-shaped read — only parentSessionId/linkedParentId are needed,
        // so never pull the multi-MB lastState blob per child.
        getSession?: (sessionId: string) => Promise<{ parentSessionId: string | null; linkedParentId?: string | null } | null>;
    } = {},
): Promise<number> {
    const _getChildSessions = deps.getChildSessions ?? getChildSessions;
    const _getSession = deps.getSession ?? getSessionSummary;

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

/** Tunable for tests. */
export const childTerminationWait = { timeoutMs: 5000, pollMs: 200 };

/**
 * Poll until the child's Redis session record disappears (termination
 * observed) or the bounded wait elapses. Returns true iff termination was
 * observed.
 */
export async function waitForChildTermination(
    childSessionId: string,
    deps: { getSession?: typeof getSessionSummary } = {},
): Promise<boolean> {
    const _getSession = deps.getSession ?? getSessionSummary;
    const deadline = Date.now() + childTerminationWait.timeoutMs;
    for (;;) {
        if (!(await _getSession(childSessionId))) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, childTerminationWait.pollMs));
    }
}

/** Deps for executeCleanupTeardown (injected for testing). */
export interface CleanupTeardownDeps {
    countPresence: () => Promise<{ kind: "count"; count: number } | { kind: "unknown" }>;
    emitRunner: (runnerId: string, event: string, data: unknown) => void;
    emitRelay: (sessionId: string, event: string, data: unknown) => void;
    endSession: (sessionId: string, reason: string, opts: { confirmedTerminal: boolean }) => Promise<void>;
}

/**
 * Cluster-aware, fail-open teardown gate for cleanup_child_session.
 *
 * Checks cluster presence FIRST. Tears down (kill_session + end_session +
 * endSharedSession) ONLY when the cluster confirms count === 0. On unknown
 * or count > 0, logs and skips — fail-open leaves the child alive so the
 * disconnect handler on the hosting node can finish cleanup naturally.
 *
 * Returns "torn-down" when teardown was executed, "skipped" otherwise.
 */
export async function executeCleanupTeardown(
    childSessionId: string,
    runnerId: string | null | undefined,
    deps: CleanupTeardownDeps,
): Promise<"torn-down" | "skipped"> {
    const presence = await deps.countPresence();

    // ALWAYS send shutdown signals — sending to an absent child is benign.
    if (runnerId) {
        deps.emitRunner(runnerId, "kill_session", { sessionId: childSessionId });
    }
    deps.emitRelay(childSessionId, "exec", {
        id: `cleanup-${childSessionId}-${Date.now()}`,
        command: "end_session",
    });

    if (presence.kind === "count" && presence.count === 0) {
        // Confirmed empty: no relay socket will fire a disconnect handler → complete teardown here.
        await deps.endSession(childSessionId, "Parent acknowledged completion", { confirmedTerminal: true });
        return "torn-down";
    }
    // count > 0 OR unknown: signals dispatched above; the disconnect handler on the hosting node
    // will call endSharedSession. Do NOT call endSession here (that was the fail-open bug).
    log.info(
        `cleanup_child_session: deferring endSession child=${childSessionId}` +
        ` presence=${presence.kind}` +
        (presence.kind === "count" ? ` count=${presence.count}` : ""),
    );
    return "skipped";
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
        const childSession = await getSharedSessionSummary(childSessionId);
        if (!childSession) {
            // Child already gone — remove any stale membership entry so the
            // dead ID doesn't linger in the parent's children set, then ack
            // (idempotent).
            await removeChildSession(sessionId, childSessionId).catch(() => {});
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
        const parentSession = await getSharedSessionSummary(sessionId);
        if (!parentSession?.userId || parentSession.userId !== childSession.userId) {
            socket.emit("error", { message: "Target session belongs to a different user" });
            if (typeof ack === "function") ack({ ok: false, error: "Target session belongs to a different user" });
            return;
        }

        log.info(`cleanup_child_session: parent=${sessionId} child=${childSessionId}`);

        try {
            // Check cluster presence FIRST — fail-open: only tear down when
            // confirmed count === 0. Unknown or count > 0 → skip teardown.
            const result = await executeCleanupTeardown(
                childSessionId,
                childSession.runnerId,
                {
                    countPresence: () => countSocketsInRoomCluster(io.of("/relay"), `session:${childSessionId}`),
                    emitRunner: emitToRunner,
                    emitRelay: emitToRelaySession,
                    endSession: endSharedSession,
                },
            );

            // Clean up child-index entry regardless of teardown result.
            void removeChildSession(sessionId, childSessionId);

            if (result === "torn-down") {
                // endSharedSession already called inside executeCleanupTeardown
                // (count === 0 path). No relay socket remained, so no disconnect
                // handler will fire — teardown is complete.
                if (typeof ack === "function") ack({ ok: true });
                return;
            }

            // Skipped (unknown or count > 0): relay socket(s) still present
            // somewhere in the cluster. The disconnect handler on the hosting
            // node will call endSharedSession when the socket drops. Wait for
            // that to be observed, then ack.
            //
            // Do NOT call endSharedSession here — that would delete the Redis
            // record before the hosting node can process the disconnect, turning
            // its endSharedSession into a no-op and stranding adopted-session
            // entries in runningSessions on the remote runner.
            const terminated = await waitForChildTermination(childSessionId);
            if (typeof ack === "function") {
                (ack as (r: { ok: boolean; pending?: boolean; error?: string }) => void)(
                    terminated ? { ok: true } : { ok: true, pending: true },
                );
            }
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
                // Fetch all session hashes concurrently, then check delink markers
                // only for the subset that started after the epoch.
                const sessions = await Promise.all(childIds.map((childId) => getSessionSummary(childId)));
                const markerCandidates = childIds.filter((_, i) => {
                    const childSession = sessions[i];
                    if (!childSession?.startedAt) return false;
                    return new Date(childSession.startedAt).getTime() > epoch;
                });
                const markerResults = await Promise.all(markerCandidates.map((childId) => isChildDelinked(childId)));
                const markerMap = new Map(markerCandidates.map((childId, i) => [childId, markerResults[i]]));

                const filtered: string[] = [];
                for (let i = 0; i < childIds.length; i++) {
                    const childId = childIds[i];
                    const childSession = sessions[i];
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
                        const hasDelinkMarker = markerMap.get(childId)!;
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
            await Promise.all(
                childIds.map((childId) => {
                    // Store the parent session ID in the marker so that
                    // addChildSession can scrub the child from this parent's
                    // pending-delink retry set when the child is re-linked elsewhere.
                    return markChildAsDelinked(childId, sessionId);
                }),
            );
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
            // parent" and the child is left blocked indefinitely — child-side waits
            // no longer have a fallback timeout (see waitForTriggerResponse), so the
            // parent_delinked event below is now the only way to unblock it.
            //
            // Instead, parentSessionId is cleaned up lazily: registerTuiSession
            // checks isChildDelinked() on reconnect and clears the stale field
            // then (see sio-registry.ts).  For connected children, the parent_delinked
            // event causes rctx.parentSessionId = null so reconnects won't re-link.
            // For offline children (who never received parent_delinked), the marker
            // we just wrote above prevents re-link.
            await Promise.all(
                childIds.map(async (childId) => {
                    const payload = { parentSessionId: sessionId };
                    const delivery = await emitToRelaySessionAwaitingAck(childId, "parent_delinked", payload);
                    if (delivery.hadListeners && !delivery.acked) {
                        throw new Error(`parent_delinked delivery was not confirmed for child ${childId}`);
                    }
                    // Offline children are safe to clear from the retry set too:
                    // their delink marker will prevent re-linking on reconnect.
                    await removePendingParentDelinkChild(sessionId, childId);
                }),
            );

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

        const session = await getSharedSessionSummary(sessionId);
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
