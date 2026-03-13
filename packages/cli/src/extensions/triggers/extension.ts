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
import { getRelaySocket } from "../remote.js";

const silent = { render: (_w: number): string[] => [], invalidate: () => {} };

/** Tracks triggers this session has received (as parent) for response routing. */
export const receivedTriggers = new Map<string, { sourceSessionId: string; type: string }>();

/** Register a received trigger for response routing. Called by remote.ts on trigger receipt. */
export function trackReceivedTrigger(triggerId: string, sourceSessionId: string, type: string): void {
    receivedTriggers.set(triggerId, { sourceSessionId, type });
}

export const triggersExtension: ExtensionFactory = (pi) => {
    const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
    const ownSessionId = process.env.PIZZAPI_SESSION_ID ?? null;

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
                deliverAs: {
                    type: "string",
                    enum: ["steer", "followUp"],
                    description: "Steer interrupts immediately (default). Follow-up waits until child's turn ends.",
                },
            },
            required: ["sessionId", "message"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { sessionId: string; message: string; deliverAs?: string };
            const conn = getRelaySocket();
            if (!conn) {
                return { content: [{ type: "text" as const, text: "Error: Not connected to relay. Cannot send message to child." }] };
            }
            // Reuse existing session_message mechanism to send input to the child
            conn.socket.emit("session_message", {
                token: conn.token,
                targetSessionId: params.sessionId,
                message: params.message,
            });
            return { content: [{ type: "text" as const, text: `Message sent to child ${params.sessionId}` }] };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── respond_to_trigger ────────────────────────────────────────────────
    pi.registerTool({
        name: "respond_to_trigger",
        label: "Respond to Trigger",
        description: "Respond to a pending trigger from a child session.",
        parameters: {
            type: "object",
            properties: {
                triggerId: { type: "string", description: "The trigger ID from the child's request" },
                response: { type: "string", description: "Response text to send back to the child" },
            },
            required: ["triggerId", "response"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerId: string; response: string };
            const conn = getRelaySocket();
            if (!conn) {
                return { content: [{ type: "text" as const, text: "Error: Not connected to relay." }] };
            }
            const pending = receivedTriggers.get(params.triggerId);
            if (!pending) {
                return { content: [{ type: "text" as const, text: `Error: No pending trigger with ID ${params.triggerId}. It may have already been responded to or timed out.` }] };
            }
            conn.socket.emit("trigger_response" as any, {
                token: conn.token,
                triggerId: params.triggerId,
                response: params.response,
                targetSessionId: pending.sourceSessionId,
            });
            receivedTriggers.delete(params.triggerId);
            return { content: [{ type: "text" as const, text: `Response sent for trigger ${params.triggerId}` }] };
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
                return { content: [{ type: "text" as const, text: "Error: Not connected to relay." }] };
            }
            const pending = receivedTriggers.get(params.triggerId);
            if (!pending) {
                return { content: [{ type: "text" as const, text: `Error: No pending trigger with ID ${params.triggerId}.` }] };
            }
            // Fire an escalate trigger — the web UI can surface this to the human
            conn.socket.emit("session_trigger" as any, {
                token: conn.token,
                trigger: {
                    type: "escalate",
                    sourceSessionId: ownSessionId ?? "",
                    targetSessionId: pending.sourceSessionId,
                    payload: { reason: params.context ?? "Parent escalated", originalTriggerId: params.triggerId },
                    deliverAs: "steer" as const,
                    expectsResponse: true,
                    triggerId: params.triggerId,  // Inherit original triggerId per spec
                    ts: new Date().toISOString(),
                },
            });
            receivedTriggers.delete(params.triggerId);
            return { content: [{ type: "text" as const, text: `Trigger ${params.triggerId} escalated to human` }] };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });
};
