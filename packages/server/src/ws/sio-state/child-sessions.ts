// ============================================================================
// sio-state/child-sessions.ts — Child session tracking, delink markers, pending delinks
// ============================================================================

import { requireRedis } from "./client.js";
import {
    childrenKey,
    pendingDelinkChildrenKey,
    delinkMarkerKey,
    sessionKey,
} from "./keys.js";
import { SESSION_TTL_SECONDS, DELINK_MARKER_TTL_SECONDS } from "./types.js";
import { getSession } from "./sessions.js";

// ── Child session index ─────────────────────────────────────────────────────
// Tracks which child sessions belong to a parent session.

/** Record a child session under its parent. */
export async function addChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    // Read the delink marker value BEFORE the transaction — if the marker stores
    // the former parent's session ID, we can scrub the child from that parent's
    // pending-delink retry set in the same atomic multi.  This prevents a child
    // that was delinked from P1 and is now being (re)linked to P2 from being
    // severed again when P1 next runs /new and re-processes its retry set.
    const formerParentId = await r.get(delinkMarkerKey(childSessionId));
    const multi = r.multi();
    multi.sAdd(childrenKey(parentSessionId), childSessionId);
    multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
    // Clear any stale delink marker — a new legitimate parent link supersedes
    // any previous delink.  The marker is kept alive in registerTuiSession
    // (not consumed on first check) so that reconnect races are idempotent;
    // clearing it here when a new link is explicitly created is the safe place.
    multi.del(delinkMarkerKey(childSessionId));
    // If the former parent's ID was stored in the marker value (non-empty, non-"1"),
    // remove the child from that parent's pending-delink retry set atomically.
    if (formerParentId && formerParentId !== "1") {
        multi.sRem(pendingDelinkChildrenKey(formerParentId), childSessionId);
    }
    await multi.exec();
}

/**
 * Add a child to the parent's membership set WITHOUT clearing any delink marker.
 *
 * Used when the parent is transiently offline during the child's reconnect —
 * we still want future `delink_children` snapshots to include this child, but
 * we must not clear the delink marker (which could have been set by a previous
 * /new and should still take effect when the parent reconnects).
 */
export async function addChildSessionMembership(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    const multi = r.multi();
    multi.sAdd(childrenKey(parentSessionId), childSessionId);
    multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
    await multi.exec();
}

/** Get all child session IDs for a parent. */
export async function getChildSessions(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    return r.sMembers(childrenKey(parentSessionId));
}

/** Check whether a session is still listed as a child of the given parent.
 *  Returns false if delink_children was called (which clears the set).
 *
 *  Fallback: if the Redis children set has expired (24 h TTL) but the child's
 *  session hash still records `parentSessionId` pointing at this parent, the
 *  relationship is still live.  We re-hydrate the set in that case so that
 *  subsequent calls are fast again (self-healing after TTL expiry). */
export async function isChildOfParent(parentSessionId: string, childSessionId: string): Promise<boolean> {
    const r = requireRedis();
    const inSet = await r.sIsMember(childrenKey(parentSessionId), childSessionId);
    if (inSet) return true;

    // If the parent explicitly delinked this child (via /new), we may have
    // already cleared the children set while the child's session hash still
    // temporarily carries parentSessionId. In that window we must NOT fall
    // back to the hash, otherwise we'd re-hydrate the set and re-authorize
    // stale parent/child traffic.
    if (await isChildDelinked(childSessionId)) return false;

    // Fallback: the Redis children set may have expired without an explicit
    // delink.  Verify via the child's durable session hash.
    const childSession = await getSession(childSessionId);
    if (childSession?.parentSessionId === parentSessionId) {
        // Re-hydrate the children set and reset its TTL so future checks are
        // fast and the delink guard (clearAllChildren / clearParentSessionId)
        // still works correctly.
        const multi = r.multi();
        multi.sAdd(childrenKey(parentSessionId), childSessionId);
        multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
        await multi.exec();
        return true;
    }

    return false;
}

/**
 * Liveness check for push-notification suppression.
 *
 * Unlike `isChildOfParent` (which is an authorization helper with TTL-recovery
 * semantics), this function is designed specifically for suppression decisions:
 *
 *   1. Explicitly delinked → false (suppress stops immediately).
 *   2. Child is in the parent's membership set → true (parent online OR
 *      temporarily offline with membership preserved via addChildSessionMembership).
 *   3. Set miss: fall back to parent-key existence in Redis.  This covers the
 *      case where the membership set has expired but the parent hasn't crashed
 *      (same SESSION_TTL_SECONDS bound).  Once the parent key expires, this
 *      returns false and suppression stops.
 *
 * `linkedParentId` is used as the parent reference so the check is durable
 * through parent-offline reconnects where `parentSessionId` is cleared to null.
 */
export async function isLinkedChildForSuppression(parentSessionId: string, childSessionId: string): Promise<boolean> {
    if (await isChildDelinked(childSessionId)) return false;

    const r = requireRedis();

    // Fast path: membership set is the primary liveness signal.
    const inSet = await r.sIsMember(childrenKey(parentSessionId), childSessionId);
    if (inSet) return true;

    // Membership set expired — fall back to parent-key existence.
    // If the parent's Redis key is still present, the session either recently
    // disconnected or is still active; continue suppressing.
    // If the key is gone (crashed without delink_children, TTL expired), stop.
    return (await r.exists(sessionKey(parentSessionId))) > 0;
}

/** Refresh the TTL on an existing parent→children membership set. */
export async function refreshChildSessionsTTL(parentSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
}

// ── Pending delink children ─────────────────────────────────────────────────

export async function addPendingParentDelinkChildren(parentSessionId: string, childIds: string[]): Promise<void> {
    if (childIds.length === 0) return;
    const r = requireRedis();
    const multi = r.multi();
    multi.sAdd(pendingDelinkChildrenKey(parentSessionId), childIds);
    multi.expire(pendingDelinkChildrenKey(parentSessionId), SESSION_TTL_SECONDS);
    await multi.exec();
}

export async function getPendingParentDelinkChildren(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    return r.sMembers(pendingDelinkChildrenKey(parentSessionId));
}

export async function removePendingParentDelinkChild(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.sRem(pendingDelinkChildrenKey(parentSessionId), childSessionId);
}

export async function isPendingParentDelinkChild(parentSessionId: string, childSessionId: string): Promise<boolean> {
    const r = requireRedis();
    const member = await r.sIsMember(pendingDelinkChildrenKey(parentSessionId), childSessionId);
    return Boolean(member);
}

// ── Per-child delink markers ─────────────────────────────────────────────────
// When delink_children fires (e.g. parent ran /new), we write a TTL'd marker
// for each child.  registerTuiSession checks this on the child's next reconnect
// and refuses to restore the link, even if the child is still carrying the old
// parentSessionId in memory (e.g. it was offline during the delink and never
// received parent_delinked). The marker is NOT consumed on first reconnect —
// it persists so that reconnect races are idempotent (if the socket drops
// after the check but before the child receives `registered`, the next
// reconnect will still see the marker). The marker is cleared when a new
// legitimate parent link is established via addChildSession(), or expires
// via TTL for children that are never re-linked.

/**
 * Mark a child as explicitly delinked by the given parent.
 *
 * The parent session ID is stored as the marker value so that
 * `addChildSession` can atomically remove the child from the former
 * parent's `pending-delink-children` set when the child is re-linked to
 * a new parent.  Consumers that only need the boolean check can continue
 * to use `isChildDelinked()`.
 */
export async function markChildAsDelinked(childSessionId: string, byParentSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.set(delinkMarkerKey(childSessionId), byParentSessionId, { EX: DELINK_MARKER_TTL_SECONDS });
}

/** Check if a child has a pending delink marker. */
export async function isChildDelinked(childSessionId: string): Promise<boolean> {
    const r = requireRedis();
    return (await r.exists(delinkMarkerKey(childSessionId))) > 0;
}

/** Consume (delete) the delink marker for a child. */
export async function clearDelinkedMark(childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.del(delinkMarkerKey(childSessionId));
}

/** Remove a child from its parent's children set. */
export async function removeChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.sRem(childrenKey(parentSessionId), childSessionId);
}

/** Remove all children from a parent's children set. Returns the removed child IDs. */
export async function clearAllChildren(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    const children = await r.sMembers(childrenKey(parentSessionId));
    if (children.length > 0) {
        await r.del(childrenKey(parentSessionId));
    }
    return children;
}

/**
 * Remove only the specified children from a parent's children set.
 * Unlike clearAllChildren(), this is safe against races where a new child
 * is added between snapshot and removal — the new child stays in the set.
 */
export async function removeChildren(parentSessionId: string, childIds: string[]): Promise<void> {
    if (childIds.length === 0) return;
    const r = requireRedis();
    await r.sRem(childrenKey(parentSessionId), childIds);
}

/** Clear the parentSessionId and linkedParentId fields on a child session's Redis hash. */
export async function clearParentSessionId(childSessionId: string): Promise<void> {
    const r = requireRedis();
    // Clear both the active link (parentSessionId) and the durable linked-child
    // signal (linkedParentId) so that push-notification suppression correctly
    // stops for sessions that have been explicitly delinked.
    await r.hSet(sessionKey(childSessionId), { parentSessionId: "", linkedParentId: "" });
}
