/**
 * session-error-trigger.ts
 *
 * Pure helper that encapsulates the `session_error` trigger emission logic
 * that runs at `agent_end`. Extracted from index.ts so it can be unit-tested
 * independently of the pi extension lifecycle.
 */

import { isUsageLimitError } from "./usage-limit-error.js";

export interface SessionErrorParams {
    /** Whether a session_error trigger has already been fired this session. */
    sessionErrorFired: boolean;
    /** The error message from the last retryable error, if any. */
    errorMessage: string | undefined | null;
    /** Whether this session is a child of another session. */
    isChildSession: boolean;
    /** The parent session ID, or null/undefined if not a child. */
    parentSessionId: string | null | undefined;
    /** Whether the Socket.IO socket is currently connected. */
    socketConnected: boolean;
    /**
     * Function that emits an event on the Socket.IO socket.
     * Null when the socket is unavailable.
     */
    emitFn: ((event: string, payload: unknown) => void) | null;
    /** Relay auth token. */
    relayToken: string | undefined | null;
    /** Relay session ID (source of the trigger). */
    relaySessionId: string | undefined | null;
}

/**
 * Fires a `session_error` trigger to the parent session if all preconditions
 * are met and the error message is a known usage-limit error.
 *
 * Preconditions (all must hold):
 *  - `sessionErrorFired` is false (one-shot guard)
 *  - `errorMessage` is a non-empty string
 *  - `isChildSession` is true
 *  - `parentSessionId` is set
 *  - `socketConnected` is true
 *  - `emitFn` is available
 *  - `relayToken` and `relaySessionId` are set
 *  - `isUsageLimitError(errorMessage)` returns true
 *
 * @returns `true` if the trigger was fired; `false` if any precondition failed.
 */
export function maybeFireSessionError(params: SessionErrorParams): boolean {
    const {
        sessionErrorFired,
        errorMessage,
        isChildSession,
        parentSessionId,
        socketConnected,
        emitFn,
        relayToken,
        relaySessionId,
    } = params;

    if (
        !sessionErrorFired &&
        errorMessage &&
        isChildSession &&
        parentSessionId &&
        socketConnected &&
        emitFn &&
        relayToken &&
        relaySessionId &&
        isUsageLimitError(errorMessage)
    ) {
        emitFn("session_trigger", {
            token: relayToken,
            trigger: {
                type: "session_error",
                sourceSessionId: relaySessionId,
                sourceSessionName: undefined,
                targetSessionId: parentSessionId,
                payload: {
                    message: errorMessage,
                },
                deliverAs: "steer" as const,
                expectsResponse: true,
                triggerId: crypto.randomUUID(),
                ts: new Date().toISOString(),
            },
        });
        return true;
    }
    return false;
}
