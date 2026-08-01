/**
 * Headless fork ("rewind") support for the session worker.
 *
 * Mirrors pi's AgentSessionRuntime.fork() for headless mode: branch the
 * session tree at (or just before) an entry, point the SessionManager at the
 * new branched session file, and rebuild the agent transcript — without the
 * interactive-mode runtime host that upstream fork depends on.
 */

/** Minimal slice of AgentSession that headlessFork needs. */
export interface ForkableSession {
    sessionFile: string | undefined;
    sessionManager: {
        getEntry(id: string): any;
        newSession(options?: { parentSession?: string }): string | undefined;
        createBranchedSession(leafId: string): string | undefined;
        isPersisted(): boolean;
        getSessionId(): string;
        buildSessionContext(): { messages: unknown[] };
    };
    agent: { sessionId?: string | undefined; state: { messages: unknown[] } };
    extensionRunner?: {
        hasHandlers(type: string): boolean;
        emit(event: unknown): Promise<unknown>;
    } | null;
    abort(): Promise<void>;
}

export function extractUserMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("");
    }
    return "";
}

/**
 * Fork the session at `entryId`.
 *
 * position "before" (default): entryId must be a user message; the forked
 * session contains everything up to (excluding) that message, and its text is
 * returned so the caller can pre-fill an editor. position "at": the forked
 * session includes the entry itself (pi's /clone behavior).
 *
 * @param onSessionReplaced Invoked right after the SessionManager points at
 *        the forked session file, before extensions are notified — the worker
 *        uses this to republish session metadata.
 */
export async function headlessFork(
    session: ForkableSession,
    entryId: string,
    options?: { position?: "before" | "at" },
    onSessionReplaced?: () => void,
): Promise<{ cancelled: boolean; selectedText?: string }> {
    const extensionRunner = session.extensionRunner;
    const previousSessionFile = session.sessionFile;
    const position = options?.position ?? "before";

    const sm = session.sessionManager;
    const entry = sm.getEntry(entryId);
    if (!entry) {
        throw new Error("Invalid entry ID for forking");
    }

    let targetLeafId: string | null;
    let selectedText: string | undefined;
    if (position === "at") {
        targetLeafId = entry.id;
    } else {
        if (entry.type !== "message" || entry.message?.role !== "user") {
            throw new Error("Invalid entry ID for forking");
        }
        targetLeafId = entry.parentId ?? null;
        selectedText = extractUserMessageText(entry.message.content);
    }

    // Let extensions cancel (mirrors pi's session_before_fork)
    if (extensionRunner?.hasHandlers("session_before_fork")) {
        const result = await extensionRunner.emit({
            type: "session_before_fork",
            entryId,
            position,
        });
        if ((result as any)?.cancel) {
            return { cancelled: true };
        }
    }

    // Stop any running agent turn
    await session.abort();

    // Clear AgentSession's private tracking queues so stale steering/
    // follow-up messages from the pre-fork conversation don't leak through.
    (session as any)._steeringMessages = [];
    (session as any)._followUpMessages = [];
    (session as any)._pendingNextTurnMessages = [];
    (session as any)._lastAssistantMessage = undefined;
    (session as any)._overflowRecoveryAttempted = false;

    // Branch the session tree — createBranchedSession points the existing
    // SessionManager at the new session file.
    if (!targetLeafId) {
        // Forking from the very first message → fresh empty session
        sm.newSession({ parentSession: previousSessionFile });
    } else {
        const forkedPath = sm.createBranchedSession(targetLeafId);
        // In-memory sessions return undefined on success — only persisted
        // sessions are expected to yield a new session file path.
        if (sm.isPersisted() && !forkedPath) {
            throw new Error("Failed to create forked session");
        }
    }
    session.agent.sessionId = sm.getSessionId();
    onSessionReplaced?.();

    // Rebuild the transcript from the forked session
    const sessionContext = sm.buildSessionContext();

    // Notify extensions before replacing messages — the remote extension's
    // session_switch handler emits session_active from the (now forked)
    // sessionManager. NOTE: "session_switch" was removed from the upstream
    // type union in 0.66.1, but PizzaPi's remote extension still registers a
    // runtime handler for it; emit() dispatches by string key.
    if (extensionRunner) {
        await extensionRunner.emit({
            type: "session_switch",
            reason: "fork",
            previousSessionFile,
        });
    }

    session.agent.state.messages = sessionContext.messages;

    return { cancelled: false, selectedText };
}
