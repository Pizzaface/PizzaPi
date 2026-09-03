/**
 * session-complete-delivery.ts
 *
 * Builds the `lifecycle:session_complete` trigger for child sessions.
 * Unified model (ADR-0002): the trigger is published through the engine
 * (rctx.emitTriggerWithAck → POST /api/events), so delivery is an HTTP
 * round-trip with an explicit result — no socket-ack plumbing.
 */

import type { ConversationTrigger } from "../triggers/types.js";

export interface BuildSessionCompleteOptions {
    sourceSessionId: string;
    targetSessionId: string;
    triggerId: string;
    summary: string;
    exitReason: "completed" | "killed" | "error";
    fullOutputPath?: string;
}

export function buildSessionCompleteTrigger(
    opts: BuildSessionCompleteOptions,
): ConversationTrigger {
    return {
        type: "lifecycle:session_complete",
        sourceSessionId: opts.sourceSessionId,
        sourceSessionName: undefined,
        targetSessionId: opts.targetSessionId,
        payload: {
            summary: opts.summary,
            exitCode: opts.exitReason === "killed" ? 130 : opts.exitReason === "error" ? 1 : 0,
            exitReason: opts.exitReason,
            ...(opts.fullOutputPath ? { fullOutputPath: opts.fullOutputPath } : {}),
        },
        // steer: the child now waits indefinitely for an ack/follow-up (no more
        // shutdown-by-clock, see followup-grace.ts) — the parent must be interrupted
        // to notice, not left to find out whenever it next goes idle.
        deliverAs: "steer",
        expectsResponse: true,
        triggerId: opts.triggerId,
        ts: new Date().toISOString(),
    };
}