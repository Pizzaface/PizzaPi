/**
 * Session ownership resolution for trigger-system operations (ADR-0002).
 *
 * Schedules (time:*) outlive the session that created them, so publishing or
 * managing against a session must tolerate a session whose live record is
 * gone. The live Redis record is preferred (authoritative, carries the
 * current runner); the persisted relay_session row is the fallback; for
 * durable schedules the owning runner is the last resort.
 *
 * Returns null when the session is unknown or belongs to another user —
 * callers must treat that exactly like "not found" (never leak existence).
 */

import { getSharedSession } from "../ws/sio-registry.js";
import { getPersistedRelaySessionOwner } from "./store.js";
import { durableRouteRunnerId } from "../events/reconcile.js";
import { getRunnerData } from "../ws/sio-registry/runners.js";
import { getRunnerOwner } from "../runner-owner.js";

/**
 * Resolve which runner (and cwd) a session belongs to, regardless of live
 * state or owner — for the wake path (ownership was already checked at
 * publish time). Live record first, persisted row second, session-route
 * runner last.
 */
export async function resolveSessionRunner(
    sessionId: string,
): Promise<{ runnerId: string | null; cwd?: string } | null> {
    const live = await getSharedSession(sessionId);
    if (live?.runnerId) {
        return { runnerId: live.runnerId, ...(live.cwd ? { cwd: live.cwd } : {}) };
    }
    const persisted = await getPersistedRelaySessionOwner(sessionId);
    if (persisted?.runnerId) {
        return { runnerId: persisted.runnerId, ...(persisted.cwd ? { cwd: persisted.cwd } : {}) };
    }
    const runnerId = await durableRouteRunnerId(sessionId);
    if (!runnerId) return null;
    return { runnerId };
}

/**
 * True when NO owner is resolvable for the session by any user: no live
 * record, no persisted row with a user, and no runner (live or durable
 * owner record) behind its routes. Routes targeting such a session are
 * orphans — without this check they'd be unmanageable and undeletable
 * forever.
 */
export async function sessionOwnerUnresolvable(sessionId: string): Promise<boolean> {
    if (await getSharedSession(sessionId)) return false;
    const persisted = await getPersistedRelaySessionOwner(sessionId);
    if (persisted?.userId) return false;
    const runnerId = persisted?.runnerId ?? (await durableRouteRunnerId(sessionId));
    if (!runnerId) return true;
    if (await getRunnerData(runnerId).catch(() => null)) return false;
    return (await getRunnerOwner(runnerId)) === null;
}

export async function resolveSessionOwner(
    sessionId: string,
    userId: string,
): Promise<{ runnerId: string | null; cwd?: string } | null> {
    const live = await getSharedSession(sessionId);
    if (live) {
        return live.userId === userId
            ? { runnerId: live.runnerId ?? null, ...(live.cwd ? { cwd: live.cwd } : {}) }
            : null;
    }
    const persisted = await getPersistedRelaySessionOwner(sessionId);
    if (persisted) {
        if (!persisted.userId || persisted.userId !== userId) return null;
        return {
            runnerId: persisted.runnerId,
            ...(persisted.cwd ? { cwd: persisted.cwd } : {}),
        };
    }
    // Last resort: the relay-session pruner deletes ended sessions, but session
    // routes (schedules, subscriptions) outlive them. Resolve ownership through
    // the route's stamped runner — a route that exists must stay manageable by
    // the runner's owner, or it fires forever with no way to cancel it.
    const runnerId = await durableRouteRunnerId(sessionId);
    if (!runnerId) return null;
    const runner = await getRunnerData(runnerId).catch(() => null);
    if (runner) return runner.userId === userId ? { runnerId } : null;
    // Runner offline: fall back to the durable owner record (Redis state is
    // TTL'd/deleted on disconnect — see runner-owner.ts).
    if ((await getRunnerOwner(runnerId)) === userId) return { runnerId };
    return null;
}