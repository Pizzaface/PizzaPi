import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { messageBus, type SessionMessage } from "./session-message-bus.js";

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * Session Messaging extension — provides tools for agents to converse with
 * each other across sessions.
 *
 * Tools:
 *   send_message      — Send a message to another session
 *   wait_for_message   — Wait for a message from another session (blocking)
 *   check_messages     — Non-blocking peek at pending incoming messages
 */
export const sessionMessagingExtension: ExtensionFactory = (pi) => {
    // ── send_message ──────────────────────────────────────────────────────────
    pi.registerTool({
        name: "send_message",
        label: "Send Message",
        description:
            "Send a message to another agent session. The message will be delivered " +
            "to the target session where it can be received with wait_for_message. " +
            "Use this to have a conversation with another agent session.",
        parameters: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "The session ID to send the message to.",
                },
                message: {
                    type: "string",
                    description: "The message text to send.",
                },
            },
            required: ["sessionId", "message"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { sessionId: string; message: string };
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            if (!params.sessionId?.trim()) {
                return ok("Error: sessionId is required.");
            }
            if (!params.message?.trim()) {
                return ok("Error: message is required.");
            }

            const sent = messageBus.send(params.sessionId.trim(), params.message);
            if (!sent) {
                return ok("Error: Not connected to relay. Cannot send messages without a relay connection.");
            }

            return ok(`Message sent to session ${params.sessionId.trim()}.`);
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── wait_for_message ──────────────────────────────────────────────────────
    pi.registerTool({
        name: "wait_for_message",
        label: "Wait for Message",
        description:
            "Wait for a message from another agent session. Blocks until a message " +
            "arrives or the timeout expires. Use this to receive messages in a " +
            "conversation with another agent. If fromSessionId is omitted, waits " +
            "for a message from any session.",
        parameters: {
            type: "object",
            properties: {
                fromSessionId: {
                    type: "string",
                    description:
                        "Optional: only wait for messages from this specific session. " +
                        "If omitted, accepts messages from any session.",
                },
                timeout: {
                    type: "number",
                    description:
                        "Maximum time to wait in seconds. Defaults to 120. " +
                        "Returns null if no message arrives within this time.",
                },
            },
            required: [],
        } as any,

        async execute(_toolCallId, rawParams, signal) {
            const params = (rawParams ?? {}) as { fromSessionId?: string; timeout?: number };
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const fromSessionId = params.fromSessionId?.trim() || null;
            const timeoutSec = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : 120;

            // Create a timeout abort signal, merged with the tool's signal.
            const timeoutController = new AbortController();
            const timer = setTimeout(() => timeoutController.abort(), timeoutSec * 1000);

            // Merge the tool abort signal with our timeout.
            const mergedController = new AbortController();
            const onToolAbort = () => mergedController.abort();
            const onTimeoutAbort = () => mergedController.abort();
            signal?.addEventListener("abort", onToolAbort, { once: true });
            timeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });

            try {
                const msg = await messageBus.waitForMessage(fromSessionId, mergedController.signal);
                clearTimeout(timer);

                if (!msg) {
                    return ok(
                        timeoutController.signal.aborted
                            ? `No message received within ${timeoutSec} seconds.`
                            : "Wait was cancelled.",
                        { received: false, timedOut: timeoutController.signal.aborted },
                    );
                }

                return ok(
                    `Message from session ${msg.fromSessionId}:\n\n${msg.message}`,
                    {
                        received: true,
                        fromSessionId: msg.fromSessionId,
                        message: msg.message,
                        ts: msg.ts,
                    },
                );
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onToolAbort);
                timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── check_messages ────────────────────────────────────────────────────────
    pi.registerTool({
        name: "check_messages",
        label: "Check Messages",
        description:
            "Non-blocking check for pending messages from other sessions. " +
            "Returns any queued messages without waiting. Useful to poll " +
            "for messages between other work.",
        parameters: {
            type: "object",
            properties: {
                fromSessionId: {
                    type: "string",
                    description:
                        "Optional: only check messages from this specific session. " +
                        "If omitted, returns messages from all sessions.",
                },
            },
            required: [],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { fromSessionId?: string };
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const fromSessionId = params.fromSessionId?.trim() || undefined;
            const messages = messageBus.drain(fromSessionId);

            if (messages.length === 0) {
                return ok("No pending messages.", { messages: [], count: 0 });
            }

            const formatted = messages
                .map((m: SessionMessage) => `[${m.fromSessionId}] ${m.message}`)
                .join("\n\n");

            return ok(
                `${messages.length} message(s) received:\n\n${formatted}`,
                {
                    messages: messages.map((m: SessionMessage) => ({
                        fromSessionId: m.fromSessionId,
                        message: m.message,
                        ts: m.ts,
                    })),
                    count: messages.length,
                },
            );
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── get_session_id ────────────────────────────────────────────────────────
    pi.registerTool({
        name: "get_session_id",
        label: "Get Session ID",
        description:
            "Returns this session's own session ID. Useful when you need to tell " +
            "another agent your session ID so they can send messages to you.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        } as any,

        async execute() {
            const id = messageBus.getOwnSessionId();
            if (!id) {
                return {
                    content: [{ type: "text" as const, text: "Not connected to relay — session ID not available." }],
                    details: { sessionId: null } as any,
                };
            }
            return {
                content: [{ type: "text" as const, text: `This session's ID: ${id}` }],
                details: { sessionId: id } as any,
            };
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });
};
