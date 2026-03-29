// ============================================================================
// sio-state/keys.ts — All Redis key builder functions + KEY_PREFIX
// ============================================================================

export const KEY_PREFIX = "pizzapi:sio";

export function sessionKey(sessionId: string): string {
    return `${KEY_PREFIX}:session:${sessionId}`;
}

export function runnerKey(runnerId: string): string {
    return `${KEY_PREFIX}:runner:${runnerId}`;
}

export function terminalKey(terminalId: string): string {
    return `${KEY_PREFIX}:terminal:${terminalId}`;
}

export function seqKey(sessionId: string): string {
    return `${KEY_PREFIX}:seq:${sessionId}`;
}

export function runnerLinkKey(sessionId: string): string {
    return `${KEY_PREFIX}:runner-link:${sessionId}`;
}

/** Index key listing all session IDs for a given user. */
export function userSessionsKey(userId: string): string {
    return `${KEY_PREFIX}:user-sessions:${userId}`;
}

/** Global set of all active session IDs. */
export function allSessionsKey(): string {
    return `${KEY_PREFIX}:all-sessions`;
}

/** Index key listing all runner IDs for a given user. */
export function userRunnersKey(userId: string): string {
    return `${KEY_PREFIX}:user-runners:${userId}`;
}

/** Global set of all active runner IDs. */
export function allRunnersKey(): string {
    return `${KEY_PREFIX}:all-runners`;
}

/** Index key listing all terminal IDs for a given runner. */
export function runnerTerminalsKey(runnerId: string): string {
    return `${KEY_PREFIX}:runner-terminals:${runnerId}`;
}

export function runnerAssocKey(sessionId: string): string {
    return `${KEY_PREFIX}:runner-assoc:${sessionId}`;
}

/** Set of child session IDs for a parent session. */
export function childrenKey(parentSessionId: string): string {
    return `${KEY_PREFIX}:children:${parentSessionId}`;
}

/** Children that still need a parent_delinked notification retry for a parent. */
export function pendingDelinkChildrenKey(parentSessionId: string): string {
    return `${KEY_PREFIX}:pending-delink-children:${parentSessionId}`;
}

export function delinkMarkerKey(childSessionId: string): string {
    return `${KEY_PREFIX}:delinked:${childSessionId}`;
}

export function pushPendingKey(sessionId: string): string {
    return `pizzapi:push-pending:${sessionId}`;
}
