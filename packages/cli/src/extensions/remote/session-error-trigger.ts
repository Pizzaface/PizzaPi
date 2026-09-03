/**
 * session-error-trigger.ts
 *
 * Pure helper that encapsulates the `lifecycle:session_error` event emission
 * logic that runs at `agent_end`. Extracted from index.ts so it can be
 * unit-tested independently of the pi extension lifecycle.
 */

import type { ConversationTrigger } from "../triggers/types.js";
import { isUsageLimitError } from "./usage-limit-error.js";

export interface SessionErrorParams {
    /** Whether a session_error event has already been fired this session. */
    sessionErrorFired: boolean;
    /** The error message from the last retryable error, if any. */
    errorMessage: string | undefined | null;
    /** Whether this session is a child of another session. */
    isChildSession: boolean;
    /** The parent session ID, or null/undefined if not a child. */
    parentSessionId: string | null | undefined;
    /** Relay session ID (source of the event). */
    relaySessionId: string | undefined | null;
    /**
     * Publishes the built trigger through the unified engine
     * (rctx.emitTriggerWithAck). Null when unavailable.
     */
    emitTriggerWithAck: ((trigger: ConversationTrigger) => Promise<{ ok: boolean; error?: string }>) | null;
}

/**
 * Publish a `lifecycle:session_error` event to the parent session if all
 * preconditions are met and the error message is a known usage-limit error.
 *
 * Preconditions (all must hold):
 *  - `sessionErrorFired` is false (one-shot guard)
 *  - `errorMessage` is a non-empty string
 *  - `isChildSession` is true
 *  - `parentSessionId` is set
 *  - `relaySessionId` is set
 *  - `emitTriggerWithAck` is available
 *  - `isUsageLimitError(errorMessage)` returns true
 *
 * @returns `true` if the event was published (and the publish succeeded);
 *          `false` if any precondition failed.
 */
export async function maybeFireSessionError(params: SessionErrorParams): Promise<boolean> {
    const {
        sessionErrorFired,
        errorMessage,
        isChildSession,
        parentSessionId,
        relaySessionId,
        emitTriggerWithAck,
    } = params;

    if (
        !sessionErrorFired &&
        errorMessage &&
        isChildSession &&
        parentSessionId &&
        relaySessionId &&
        emitTriggerWithAck &&
        isUsageLimitError(errorMessage)
    ) {
        const trigger: ConversationTrigger = {
            type: "lifecycle:session_error",
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
        };
        const result = await emitTriggerWithAck(trigger);
        return result.ok;
    }
    return false;
}