// ============================================================================
// triggers/extension.ts — Trigger tools for parent-child session communication
//
// Provides three tools:
//   - tell_child: Send a message to a linked child session
//   - respond_to_trigger: Respond to a pending trigger from a child
//   - escalate_trigger: Escalate a child's trigger to the human viewer
// ============================================================================

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { ConversationTrigger } from "./types.js";
import { getRelaySocket, getRelaySessionId } from "../remote.js";
import {
    fireTrigger,
    getAvailableTriggers,
    subscribeTrigger,
    listTriggerSubscriptions,
    unsubscribeTrigger,
} from "../trigger-client.js";

function shortId(id: string, len = 8): string {
    return id.length > len ? id.slice(-len) : id;
}
function preview(text: string, max = 50): string {
    return text.length > max ? text.slice(0, max) + "..." : text;
}

/** Tracks triggers this session has received (as parent) for response routing. */
export const receivedTriggers = new Map<string, { sourceSessionId: string; type: string; trackedAt: number }>();

const TRIGGER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Register a received trigger for response routing. Called by remote.ts on trigger receipt.
 *  If the triggerId is already tracked (e.g. after escalation re-delivers the same trigger),
 *  the original sourceSessionId is preserved so responses route back to the real child. */
/**
 * Clear all pending received triggers and optionally cancel them back to
 * children via the relay. Called on /new to prevent stale triggers from
 * the old session leaking into the new conversation.
 *
 * For each pending trigger that expects a response, sends a cancel
 * trigger_response back to the child so it doesn't block waiting forever.
 *
 * Returns the triggers that were successfully cancelled (sent) and those that
 * failed (relay socket was down at the time of /new).
 */
export function clearAndCancelPendingTriggers(
    onConfirmed?: (triggerId: string, childSessionId: string) => void,
): { cancelled: number; sent: Array<{ triggerId: string; childSessionId: string }>; failed: Array<{ triggerId: string; childSessionId: string }> } {
    const conn = getRelaySocket();
    const sent: Array<{ triggerId: string; childSessionId: string }> = [];
    const failed: Array<{ triggerId: string; childSessionId: string }> = [];

    for (const [triggerId, entry] of receivedTriggers) {
        // Send a cancel response to children so they don't block.
        if (conn) {
            // Use an ack callback so we know the server received the cancel.
            // If the socket drops before the ack arrives, the caller keeps the
            // item in pendingCancellations and retries on the next reconnect.
            // Only call onConfirmed once the server acknowledges the delivery —
            // that's the signal to remove this item from the retry queue.
            const capturedTriggerId = triggerId;
            const capturedChildSessionId = entry.sourceSessionId;
            conn.socket.emit("trigger_response" as any, {
                token: conn.token,
                triggerId: capturedTriggerId,
                response: "Parent started a new session — trigger cancelled.",
                action: "cancel",
                targetSessionId: capturedChildSessionId,
            }, (result: { ok: boolean; error?: string }) => {
                if (result?.ok) {
                    onConfirmed?.(capturedTriggerId, capturedChildSessionId);
                }
                // If !ok, the item stays in pendingCancellations for retry on reconnect.
            });
            // Mark as sent-pending-ack: caller should add to pendingCancellations
            // so the retry path handles the case where the socket drops before the ack.
            sent.push({ triggerId, childSessionId: entry.sourceSessionId });
        } else {
            failed.push({ triggerId, childSessionId: entry.sourceSessionId });
        }
    }

    const count = receivedTriggers.size;
    receivedTriggers.clear();
    return { cancelled: count, sent, failed };
}

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
        renderCall: (args: any, theme: any) => {
            const sid = shortId(args.sessionId ?? "", 8);
            const msg = preview(args.message ?? "", 50);
            return new Text(
                theme.fg("accent", "→") + " " +
                theme.fg("muted", "child ") +
                theme.fg("dim", sid) +
                theme.fg("muted", ": ") +
                theme.fg("dim", msg),
                0, 0
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            if (text.startsWith("Error:")) {
                return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
            }
            return new Text(theme.fg("success", "✓ ") + theme.fg("dim", "delivered"), 0, 0);
        },
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
                    const result = await new Promise<{ ok: boolean; text: string }>((resolve) => {
                        const timeout = setTimeout(() => {
                            conn.socket.off("session_message_error", onError);
                            resolve({ ok: true, text: `Follow-up sent to child ${childId}` });
                        }, 3000);

                        const onError = (err: { targetSessionId: string; error: string }) => {
                            if (err.targetSessionId === childId) {
                                clearTimeout(timeout);
                                conn.socket.off("session_message_error", onError);
                                resolve({ ok: false, text: `Error sending follow-up to child ${childId}: ${err.error}` });
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
                    if (result.ok) {
                        receivedTriggers.delete(params.triggerId);
                    }
                    return { content: [{ type: "text" as const, text: result.text }], details: null as any };
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
        renderCall: (args: any, theme: any) => {
            const tid = shortId(args.triggerId ?? "", 8);
            const action = args.action ?? "respond";
            const actionColor =
                action === "approve" || action === "ack" ? "success" :
                action === "cancel" ? "error" :
                action === "followUp" || action === "edit" ? "warning" : "muted";
            const resp = preview(args.response ?? "", 40);
            return new Text(
                theme.fg("accent", "↩") + " " +
                theme.fg("muted", "trigger ") +
                theme.fg("dim", tid) + " " +
                theme.fg(actionColor, `[${action}]`) +
                (resp ? theme.fg("dim", " " + resp) : ""),
                0, 0
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            const isSuccess = text.startsWith("Response sent for trigger") || text.startsWith("Acknowledged") || text.startsWith("Follow-up sent");
            if (!isSuccess) {
                return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
            }
            return new Text(theme.fg("success", "✓ ") + theme.fg("dim", "trigger responded"), 0, 0);
        },
    });

    // ── fire_trigger ──────────────────────────────────────────────────────
    pi.registerTool({
        name: "fire_trigger",
        label: "Fire Trigger",
        description:
            "Fire a trigger into any session (not just children). Uses the HTTP Trigger API " +
            "with API key auth, with Socket.IO fallback for offline/local mode. " +
            "This lets agents fire triggers into peer sessions they are not directly linked to.",
        parameters: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Target session ID to fire the trigger into",
                },
                type: {
                    type: "string",
                    description: "Trigger type — e.g. 'service', 'webhook', 'godmother:idea_started'",
                },
                payload: {
                    type: "object",
                    description: "Arbitrary payload object delivered to the session",
                },
                source: {
                    type: "string",
                    description: "Optional source identifier shown in trigger history (e.g. 'godmother', 'github')",
                },
                deliverAs: {
                    type: "string",
                    enum: ["steer", "followUp"],
                    description: "How to deliver: 'steer' (default) interrupts the current turn; 'followUp' queues after the turn ends",
                },
            },
            required: ["sessionId", "type", "payload"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as {
                sessionId: string;
                type: string;
                payload: Record<string, unknown>;
                source?: string;
                deliverAs?: "steer" | "followUp";
            };

            const result = await fireTrigger(params.sessionId, {
                type: params.type,
                payload: params.payload,
                source: params.source,
                deliverAs: params.deliverAs,
            });

            if (result.ok) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Trigger ${result.triggerId} fired to session ${params.sessionId} via ${result.method}`,
                    }],
                    details: null as any,
                };
            }
            return {
                content: [{
                    type: "text" as const,
                    text: `Error firing trigger to session ${params.sessionId}: ${result.error ?? "Unknown error"}`,
                }],
                details: null as any,
            };
        },
        renderCall: (args: any, theme: any) => {
            const sid = shortId(args.sessionId ?? "", 8);
            const type = preview(args.type ?? "?", 30);
            const via = args.deliverAs === "followUp" ? "followUp" : "steer";
            return new Text(
                theme.fg("accent", "⚡") + " " +
                theme.fg("muted", "fire ") +
                theme.fg("dim", type) +
                theme.fg("muted", " → ") +
                theme.fg("dim", sid) +
                theme.fg("muted", ` [${via}]`),
                0, 0
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            if (text.startsWith("Error")) {
                return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
            }
            const method = text.includes("http") ? "HTTP" : "Socket.IO";
            return new Text(theme.fg("success", "✓ ") + theme.fg("dim", `trigger fired via ${method}`), 0, 0);
        },
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
        renderCall: (args: any, theme: any) => {
            const tid = shortId(args.triggerId ?? "", 8);
            return new Text(
                theme.fg("warning", "↑") + " " +
                theme.fg("muted", "escalating trigger ") +
                theme.fg("dim", tid),
                0, 0
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            if (text.startsWith("Error:")) {
                return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
            }
            return new Text(theme.fg("warning", "↑ ") + theme.fg("dim", "trigger escalated to human"), 0, 0);
        },
    });

    // ── list_available_triggers ───────────────────────────────────────────
    pi.registerTool({
        name: "list_available_triggers",
        label: "List Available Triggers",
        description:
            "List trigger types available on this session's runner. " +
            "Shows all triggers declared by runner services that can be subscribed to. " +
            "Returns type, label, and optional description for each trigger. " +
            "Also shows which triggers this session is currently subscribed to.",
        parameters: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to query. Defaults to the current session if omitted.",
                },
            },
            required: [],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { sessionId?: string };
            const targetId = params.sessionId ?? getOwnSessionId() ?? "";
            if (!targetId) {
                return { content: [{ type: "text" as const, text: "Error: Could not determine session ID." }], details: null as any };
            }

            const [defs, subs] = await Promise.all([
                getAvailableTriggers(targetId),
                listTriggerSubscriptions(targetId),
            ]);
            if (defs.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "No trigger types available. The runner may not have any services with declared triggers." }],
                    details: null as any,
                };
            }

            const subscribedTypes = new Set(subs.map((s) => s.triggerType));
            const lines = defs.map((d) => {
                const badge = subscribedTypes.has(d.type) ? " ✅ subscribed" : "";
                let paramInfo = "";
                if (d.params && d.params.length > 0) {
                    const paramParts = d.params.map((p: any) => {
                        const req = p.required ? " (required)" : "";
                        const def = p.default !== undefined ? ` [default: ${p.default}]` : "";
                        const enumInfo = p.enum ? ` {${p.enum.join(", ")}}` : "";
                        const multi = p.multiselect ? " (multiselect)" : "";
                        return `    - ${p.name}: ${p.type}${req}${def}${enumInfo}${multi}${p.description ? ` — ${p.description}` : ""}`;
                    });
                    paramInfo = `\n  Params:\n${paramParts.join("\n")}`;
                }
                return `• ${d.type} — ${d.label}${badge}${d.description ? `\n  ${d.description}` : ""}${paramInfo}`;
            });
            return {
                content: [{ type: "text" as const, text: `Available triggers (${defs.length}):\n${lines.join("\n")}` }],
                details: null as any,
            };
        },
        renderCall: (args: any, theme: any) => {
            const sid = args.sessionId ? shortId(args.sessionId, 8) : "self";
            return new Text(
                theme.fg("accent", "⚡") + " " +
                theme.fg("muted", "list triggers for ") +
                theme.fg("dim", sid),
                0, 0,
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            if (text.startsWith("Error") || text.startsWith("No trigger")) {
                return new Text(theme.fg("muted", preview(text, 60)), 0, 0);
            }
            const count = text.match(/Available triggers \((\d+)\)/)?.[1] ?? "?";
            const subCount = (text.match(/✅/g) ?? []).length;
            const subLabel = subCount > 0 ? `, ${subCount} subscribed` : "";
            return new Text(theme.fg("success", "✓ ") + theme.fg("dim", `${count} trigger(s) available${subLabel}`), 0, 0);
        },
    });

    // ── subscribe_trigger ─────────────────────────────────────────────────
    pi.registerTool({
        name: "subscribe_trigger",
        label: "Subscribe to Trigger",
        description:
            "Subscribe a session to a trigger type from a runner service. " +
            "When the service fires that trigger type, it will be delivered to the subscribed session. " +
            "The trigger type must be declared by a service on the session's runner " +
            "(use list_available_triggers to discover valid types). " +
            "To subscribe a child session, pass its sessionId. " +
            "Some triggers accept params that filter which events you receive " +
            "(e.g. { prNumber: 42 } to only get events for PR #42). " +
            "Use list_available_triggers to see available params for each trigger type.",
        parameters: {
            type: "object",
            properties: {
                triggerType: {
                    type: "string",
                    description: "Trigger type to subscribe to, e.g. 'godmother:idea_moved'",
                },
                sessionId: {
                    type: "string",
                    description: "Session ID to subscribe. Defaults to the current session if omitted.",
                },
                params: {
                    type: "object",
                    description: "Optional subscription params to filter trigger delivery. Keys must match the trigger's declared param names. Values are matched against the trigger payload at delivery time.",
                },
            },
            required: ["triggerType"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerType: string; sessionId?: string; params?: Record<string, unknown> };
            const targetId = params.sessionId ?? getOwnSessionId() ?? "";
            if (!targetId) {
                return { content: [{ type: "text" as const, text: "Error: Could not determine session ID." }], details: null as any };
            }

            // Coerce param values to primitives or arrays of primitives (multiselect)
            let subParams: Record<string, string | number | boolean | Array<string | number | boolean>> | undefined;
            if (params.params && typeof params.params === "object") {
                subParams = {};
                for (const [k, v] of Object.entries(params.params)) {
                    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                        subParams[k] = v;
                    } else if (Array.isArray(v)) {
                        const primitives = v.filter(
                            (item): item is string | number | boolean =>
                                typeof item === "string" || typeof item === "number" || typeof item === "boolean",
                        );
                        if (primitives.length > 0) subParams[k] = primitives;
                    } else if (v !== undefined && v !== null) {
                        subParams[k] = String(v);
                    }
                }
                if (Object.keys(subParams).length === 0) subParams = undefined;
            }

            const result = await subscribeTrigger(targetId, params.triggerType, {}, subParams);

            if (result.ok) {
                const paramSuffix = subParams ? ` with params ${JSON.stringify(subParams)}` : "";
                return {
                    content: [{ type: "text" as const, text: `Subscribed to '${result.triggerType}' on runner ${result.runnerId}${paramSuffix}` }],
                    details: null as any,
                };
            }
            return {
                content: [{ type: "text" as const, text: `Error subscribing to '${params.triggerType}': ${result.error}` }],
                details: null as any,
            };
        },
        renderCall: (args: any, theme: any) => {
            const type = preview(args.triggerType ?? "?", 30);
            const sid = args.sessionId ? shortId(args.sessionId, 8) : "self";
            return new Text(
                theme.fg("success", "+") + " " +
                theme.fg("muted", "subscribe ") +
                theme.fg("dim", sid) +
                theme.fg("muted", " → ") +
                theme.fg("dim", type),
                0, 0,
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            if (text.startsWith("Error")) {
                return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
            }
            return new Text(theme.fg("success", "✓ ") + theme.fg("dim", "subscribed"), 0, 0);
        },
    });

    // ── unsubscribe_trigger ───────────────────────────────────────────────
    pi.registerTool({
        name: "unsubscribe_trigger",
        label: "Unsubscribe from Trigger",
        description: "Remove a trigger subscription from a session.",
        parameters: {
            type: "object",
            properties: {
                triggerType: {
                    type: "string",
                    description: "Trigger type to unsubscribe from",
                },
                sessionId: {
                    type: "string",
                    description: "Session ID to unsubscribe. Defaults to the current session if omitted.",
                },
            },
            required: ["triggerType"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerType: string; sessionId?: string };
            const targetId = params.sessionId ?? getOwnSessionId() ?? "";
            if (!targetId) {
                return { content: [{ type: "text" as const, text: "Error: Could not determine session ID." }], details: null as any };
            }

            const result = await unsubscribeTrigger(targetId, params.triggerType);

            if (result.ok) {
                return {
                    content: [{ type: "text" as const, text: `Unsubscribed from '${result.triggerType}'` }],
                    details: null as any,
                };
            }
            return {
                content: [{ type: "text" as const, text: `Error unsubscribing from '${params.triggerType}': ${result.error}` }],
                details: null as any,
            };
        },
        renderCall: (args: any, theme: any) => {
            const type = preview(args.triggerType ?? "?", 30);
            const sid = args.sessionId ? shortId(args.sessionId, 8) : "self";
            return new Text(
                theme.fg("error", "−") + " " +
                theme.fg("muted", "unsubscribe ") +
                theme.fg("dim", sid) +
                theme.fg("muted", " ← ") +
                theme.fg("dim", type),
                0, 0,
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const text: string = result?.content?.[0]?.text ?? "";
            if (text.startsWith("Error")) {
                return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
            }
            return new Text(theme.fg("success", "✓ ") + theme.fg("dim", "unsubscribed"), 0, 0);
        },
    });
};
