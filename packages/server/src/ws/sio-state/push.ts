// ============================================================================
// sio-state/push.ts — Push pending question state with Lua scripts
// ============================================================================

import { requireRedis } from "./client.js";
import { pushPendingKey } from "./keys.js";

// ── Push pending question tracking ──────────────────────────────────────────
// Short-lived Redis key set when a push notification is sent for an
// AskUserQuestion, cleared when the tool execution ends. Used by
// /api/push/answer to reject stale or mismatched push replies.

/** Record the toolCallId of the currently pending push-notified question. */
export async function setPushPendingQuestion(sessionId: string, toolCallId: string): Promise<void> {
    const r = requireRedis();
    // Auto-expire after 24 hours (safety net — cleared explicitly on tool end,
    // session end, and disconnect). Long TTL accommodates users who are away
    // and respond to the push notification much later.
    await r.set(pushPendingKey(sessionId), toolCallId, { EX: 86400 });
}

/** Get the currently pending push-notified toolCallId, or null. */
export async function getPushPendingQuestion(sessionId: string): Promise<string | null> {
    const r = requireRedis();
    return r.get(pushPendingKey(sessionId));
}

/**
 * Atomically consume the pending push-notified toolCallId **only if it
 * matches the expected value**. Returns true if consumed, false otherwise.
 * Uses a Lua script for atomic compare-and-delete — prevents:
 * - Replay/duplicate submissions (single-use)
 * - Stale requests from burning the real pending key (compare before delete)
 */
export async function consumePushPendingQuestionIfMatches(
    sessionId: string,
    expectedToolCallId: string,
): Promise<boolean> {
    const r = requireRedis();
    const script = `
        local val = redis.call('GET', KEYS[1])
        if val == ARGV[1] then
            redis.call('DEL', KEYS[1])
            return 1
        end
        return 0
    `;
    const result = await r.eval(script, {
        keys: [pushPendingKey(sessionId)],
        arguments: [expectedToolCallId],
    });
    return result === 1;
}

/**
 * Clear the push-pending question (tool execution ended).
 * When `toolCallId` is provided, only clears if it matches the stored value —
 * prevents a cancelled/overlapping AskUserQuestion from clearing the active one's key.
 */
export async function clearPushPendingQuestion(sessionId: string, toolCallId?: string): Promise<void> {
    const r = requireRedis();
    if (toolCallId) {
        // Atomic compare-and-delete: only clear if the stored value matches
        const script = `
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
        `;
        await r.eval(script, { keys: [pushPendingKey(sessionId)], arguments: [toolCallId] });
    } else {
        // Unconditional clear (session teardown paths)
        await r.del(pushPendingKey(sessionId));
    }
}
