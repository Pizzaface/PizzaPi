/** Commands/listing are session-scoped even though HTTP URLs are runner-scoped. */
export function resolveTunnelSession(
    runnerId: string,
    activeSessionId: string | null,
    cachedSessionId: string | undefined,
    sessions: readonly { sessionId: string; runnerId?: string | null }[],
): string | undefined {
    const belongs = (id: string) => sessions.some(s => s.sessionId === id && s.runnerId === runnerId);
    if (activeSessionId && belongs(activeSessionId)) return activeSessionId;
    if (cachedSessionId && belongs(cachedSessionId)) return cachedSessionId;
    return sessions.find(s => s.runnerId === runnerId)?.sessionId;
}
