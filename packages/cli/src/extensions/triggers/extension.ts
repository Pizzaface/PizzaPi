// ============================================================================
// triggers/extension.ts — Trigger tools for parent-child session communication
//
// Provides three tools:
//   - tell_child: Send a message to a linked child session
//   - respond_to_trigger: Respond to a pending trigger from a child
//   - escalate_trigger: Escalate a child's trigger to the human viewer
// ============================================================================

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ConversationTrigger } from "./types.js";
import { getRelaySocket, getRelaySessionId } from "../remote.js";

const silent = { render: (_w: number): string[] => [], invalidate: () => {} };

/** Tracks triggers this session has received (as parent) for response routing. */
export const receivedTriggers = new Map<string, { sourceSessionId: string; type: string; trackedAt: number }>();

const TRIGGER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Register a received trigger for response routing. Called by remote.ts on trigger receipt.
 *  If the triggerId is already tracked (e.g. after escalation re-delivers the same trigger),
 *  the original sourceSessionId is preserved so responses route back to the real child. */
export function trackReceivedTrigger(triggerId: string, sourceSessionId: string, type: string): void {
    if (receivedTriggers.has(triggerId)) return; // preserve original source on re-delivery
    receivedTriggers.set(triggerId, { sourceSessionId, type, trackedAt: Date.now() });
    // Prune stale entries to prevent unbounded growth
    const now = Date.now();
    for (const [id, entry] of receivedTriggers) {
        if (now - entry.trackedAt > TRIGGER_TTL_MS) receivedTriggers.delete(id);
    }
}

export const triggersExtension: ExtensionFactory = (pi) => {
    const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
    // Use getRelaySessionId() which works for both runner-spawned workers
    // (PIZZAPI_SESSION_ID) and standalone CLI sessions (relay-assigned ID).
    const getOwnSessionId = () => getRelaySessionId();

    // NOTE: session_complete trigger is fired from remote.ts's session_shutdown
    // handler, directly before disconnect(), to guarantee the socket is still
    // connected when the emit happens.

    // ── tell_child ────────────────────────────────────────────────────────
    pi.registerTool({
        name: "tell_child",
        label: "Tell Child",
        description: "Send a message to a linked child session.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", description: "Child session ID" },
                message: { type: "string", description: "Message to send" },
            },
            required: ["sessionId", "message"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { sessionId: string; message: string };
            const conn = getRelaySocket();
            if (!conn) {
                return { content: [{ type: "text" as const, text: "Error: Not connected to relay. Cannot send message to child." }], details: null as any };
            }

            // Deliver as agent input so it starts a new turn in the child session
            // (not into the passive message bus which requires wait_for_message).
            const result = await new Promise<string>((resolve) => {
                const timeout = setTimeout(() => {
                    conn.socket.off("session_message_error", onError);
                    resolve(`Message sent to child ${params.sessionId}`);
                }, 3000);

                const onError = (err: { targetSessionId: string; error: string }) => {
                    if (err.targetSessionId === params.sessionId) {
                        clearTimeout(timeout);
                        conn.socket.off("session_message_error", onError);
                        resolve(`Error: ${err.error}`);
                    }
                };
                conn.socket.on("session_message_error", onError);

                conn.socket.emit("session_message", {
                    token: conn.token,
                    targetSessionId: params.sessionId,
                    message: params.message,
                    deliverAs: "input",
                });
            });

            return { content: [{ type: "text" as const, text: result }], details: null as any };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── respond_to_trigger ────────────────────────────────────────────────
    pi.registerTool({
        name: "respond_to_trigger",
        label: "Respond to Trigger",
        description: "Respond to a pending trigger from a child session. Use 'action' to declare your intent explicitly.",
        parameters: {
            type: "object",
            properties: {
                triggerId: { type: "string", description: "The trigger ID from the child's request" },
                response: { type: "string", description: "Response text to send back to the child" },
                action: {
                    type: "string",
                    enum: ["approve", "cancel", "ack", "followUp", "edit"],
                    description: "Structured action: approve (accept plan), cancel (reject), ack (acknowledge completion), followUp (request more work), edit (suggest changes). Required for plan_review and session_complete triggers.",
                },
            },
            required: ["triggerId", "response"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerId: string; response: string; action?: string };
            const conn = getRelaySocket();
            if (!conn) {
                return { content: [{ type: "text" as const, text: "Error: Not connected to relay." }], details: null as any };
            }
            const pending = receivedTriggers.get(params.triggerId);
            if (!pending) {
                return { content: [{ type: "text" as const, text: `Error: No pending trigger with ID ${params.triggerId}. It may have already been responded to or timed out.` }], details: null as any };
            }
            // Enforce TTL — reject if the trigger has expired (child likely already timed out)
            if (Date.now() - pending.trackedAt > TRIGGER_TTL_MS) {
                receivedTriggers.delete(params.triggerId);
                return { content: [{ type: "text" as const, text: `Error: Trigger ${params.triggerId} has expired (older than ${TRIGGER_TTL_MS / 60_000} minutes). The child session likely already timed out.` }], details: null as any };
            }

            // session_complete is respondable but handled differently:
            // - "ack": just acknowledge, no message to child
            // - "followUp": deliver as input message to resume the child (like tell_child)
            if (pending.type === "session_complete") {
                const action = params.action ?? "ack";
                if (action === "followUp") {
                    // Deliver as agent input so it starts a new turn in the child.
                    // Wait for session_message_error to detect delivery failures.
                    const childId = pending.sourceSessionId;
                    const result = await new Promise<string>((resolve) => {
                        const timeout = setTimeout(() => {
                            conn.socket.off("session_message_error", onError);
                            resolve(`Follow-up sent to child ${childId}`);
                        }, 3000);

                        const onError = (err: { targetSessionId: string; error: string }) => {
                            if (err.targetSessionId === childId) {
                                clearTimeout(timeout);
                                conn.socket.off("session_message_error", onError);
                                resolve(`Error sending follow-up to child ${childId}: ${err.error}`);
                            }
                        };
                        conn.socket.on("session_message_error", onError);

                        conn.socket.emit("session_message", {
                            token: conn.token,
                            targetSessionId: childId,
                            message: params.response,
                            deliverAs: "input",
                        });
                    });
                    receivedTriggers.delete(params.triggerId);
                    return { content: [{ type: "text" as const, text: result }], details: null as any };
                }
                // ack or any other action — acknowledge and clean up the child session
                // Emit cleanup request to the relay so the server tears down the
                // child session (removes from Redis, notifies runner, frees resources).
                // Wait for the server's ack before clearing the trigger — if the
                // relay rejects the request (auth, ownership), we keep the trigger
                // so the agent can retry or escalate.
                const cleanupResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
                    const timeout = setTimeout(() => resolve({ ok: false, error: "Cleanup ack timed out" }), 10_000);
                    conn.socket.emit("cleanup_child_session", {
                        token: conn.token,
                        childSessionId: pending.sourceSessionId,
                    }, (result: { ok: boolean; error?: string }) => {
                        clearTimeout(timeout);
                        resolve(result ?? { ok: true });
                    });
                });
                if (!cleanupResult.ok) {
                    // Don't delete the trigger — agent can retry
                    return { content: [{ type: "text" as const, text: `Failed to clean up child session ${pending.sourceSessionId}: ${cleanupResult.error ?? "unknown error"}` }], details: null as any };
                }
                receivedTriggers.delete(params.triggerId);
                return { content: [{ type: "text" as const, text: `Acknowledged session completion from ${pending.sourceSessionId}` }], details: null as any };
            }

            conn.socket.emit("trigger_response" as any, {
                token: conn.token,
                triggerId: params.triggerId,
                response: params.response,
                ...(params.action ? { action: params.action } : {}),
                targetSessionId: pending.sourceSessionId,
            });
            receivedTriggers.delete(params.triggerId);
            return { content: [{ type: "text" as const, text: `Response sent for trigger ${params.triggerId}` }], details: null as any };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── escalate_trigger ──────────────────────────────────────────────────
    pi.registerTool({
        name: "escalate_trigger",
        label: "Escalate Trigger",
        description: "Escalate a child's trigger to the human viewer.",
        parameters: {
            type: "object",
            properties: {
                triggerId: { type: "string", description: "The trigger ID to escalate" },
                context: { type: "string", description: "Additional context for the human" },
            },
            required: ["triggerId"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerId: string; context?: string };
            const conn = getRelaySocket();
            if (!conn) {
                return { content: [{ type: "text" as const, text: "Error: Not connected to relay." }], details: null as any };
            }
            const pending = receivedTriggers.get(params.triggerId);
            if (!pending) {
                return { content: [{ type: "text" as const, text: `Error: No pending trigger with ID ${params.triggerId}.` }], details: null as any };
            }
            // Fire an escalate trigger to the parent's own session so the web UI
            // surfaces it to the human viewer (not back to the child).
            conn.socket.emit("session_trigger" as any, {
                token: conn.token,
                trigger: {
                    type: "escalate",
                    sourceSessionId: pending.sourceSessionId,
                    targetSessionId: getOwnSessionId() ?? "",
                    payload: { reason: params.context ?? "Parent escalated", originalTriggerId: params.triggerId },
                    deliverAs: "steer" as const,
                    expectsResponse: true,
                    triggerId: params.triggerId,  // Inherit original triggerId per spec
                    ts: new Date().toISOString(),
                },
            });
            // Don't delete from receivedTriggers — the trigger is still pending
            // and respond_to_trigger needs the original sourceSessionId to route
            // the response back to the child (not the parent).
            return { content: [{ type: "text" as const, text: `Trigger ${params.triggerId} escalated to human` }], details: null as any };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });
};
