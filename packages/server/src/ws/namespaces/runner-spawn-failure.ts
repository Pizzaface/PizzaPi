import type { PublishEventInput, SourceIdentity, SpawnFailureDetails } from "@pizzapi/protocol";
import type { EngineDeps } from "../../events/engine.js";
import { publishEvent } from "../../events/engine.js";

/** Minimal shape this module needs from a Redis session record. */
export type SpawnFailureSessionRef = { userId?: string | null; runnerId?: string | null; parentSessionId?: string | null; linkedParentId?: string | null } | null;

/** Minimal shape of the pending-spawn binding recorded at spawn-request time. */
export type PendingChildSpawnRef = { runnerId: string; parentSessionId: string | null } | null | undefined;

/**
 * Authorize a runner's self-reported child-spawn failure before it is
 * published as a steer to the parent session.
 *
 * A `session_error` payload (sessionId, parentSessionId) comes straight from
 * an authenticated runner socket and MUST NOT be trusted on its own —
 * otherwise any runner can name another user's live session as "parent" and
 * inject an arbitrary lifecycle:session_complete failure into it. This
 * requires three things to hold, all backed by server-side records the
 * reporting runner cannot forge:
 *
 *  (a) the parent session exists and belongs to the SAME user as this
 *      runner socket;
 *  (b) the child session is actually assigned to THIS runner — either
 *      confirmed (it registered and its Redis record names this runner), or
 *      it is still a pending spawn this runner was asked to perform;
 *  (c) the recorded parent-child relationship matches the parentSessionId
 *      being reported (the child's own parentSessionId/linkedParentId, or
 *      the pending spawn's requested parent) — not just "some" relationship.
 */
export function isAuthorizedChildSpawnFailure(args: {
    runnerId: string;
    runnerUserId?: string | null;
    parentSessionId: string;
    parentSession: SpawnFailureSessionRef;
    childSession: SpawnFailureSessionRef;
    pendingSpawn: PendingChildSpawnRef;
}): boolean {
    if (!args.runnerUserId) return false;
    if (!args.parentSession || args.parentSession.userId !== args.runnerUserId) return false;

    if (args.childSession) {
        // Established child (it registered with the relay at least once):
        // trust the durable Redis binding over anything self-reported.
        const boundParentSessionId = args.childSession.parentSessionId ?? args.childSession.linkedParentId ?? null;
        return args.childSession.runnerId === args.runnerId && boundParentSessionId === args.parentSessionId;
    }

    // Not registered yet (e.g. a fail-closed sandbox exits before the worker
    // ever reaches the relay) — fall back to the binding recorded when the
    // spawn was legitimately requested and validated.
    if (!args.pendingSpawn) return false;
    return args.pendingSpawn.runnerId === args.runnerId && args.pendingSpawn.parentSessionId === args.parentSessionId;
}

export function buildChildSpawnFailureEvent(args: {
    sessionId: string;
    parentSessionId: string;
    failure: SpawnFailureDetails;
}): PublishEventInput {
    const detail = args.failure.detail || "Child session failed";
    return {
        type: "lifecycle:session_complete",
        summary: `Child session failed: ${detail}`,
        payload: {
            summary: `Child session ${args.sessionId} failed: ${detail}`,
            exitReason: "error",
            exitCode: args.failure.exitCode ?? 1,
            failure: {
                kind: args.failure.kind,
                detail: args.failure.detail,
                exitCode: args.failure.exitCode ?? null,
            },
        },
        responseContract: { actions: ["ack", "followUp"] },
        fireId: `spawn-failure:${args.sessionId}`,
    };
}

export async function publishChildSpawnFailure(
    args: {
        sessionId: string;
        parentSessionId?: string;
        failure?: SpawnFailureDetails;
        userId?: string;
    },
    deps: EngineDeps,
): Promise<boolean> {
    if (!args.parentSessionId || !args.failure || !args.userId) return false;
    const source: SourceIdentity = {
        kind: "session",
        id: args.sessionId,
        name: "spawn_session failure",
        auth: "internal",
        userId: args.userId,
    };
    await publishEvent(
        buildChildSpawnFailureEvent({
            sessionId: args.sessionId,
            parentSessionId: args.parentSessionId,
            failure: args.failure,
        }),
        source,
        deps,
        [{ sessionId: args.parentSessionId, deliverAs: "steer" }],
    );
    return true;
}
