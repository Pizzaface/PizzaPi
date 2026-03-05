import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
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

    // ── session_status ────────────────────────────────────────────────────────
    pi.registerTool({
        name: "session_status",
        label: "Session Status",
        description:
            "Query the current status of another agent session. Returns session " +
            "state including active/idle/completed/error status, model, session name, " +
            "parent/child relationships, and last activity time.",
        parameters: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "The session ID to query the status of.",
                },
            },
            required: ["sessionId"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { sessionId: string };
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            if (!params.sessionId?.trim()) {
                return ok("Error: sessionId is required.");
            }

            const targetSessionId = params.sessionId.trim();
            const requestId = randomUUID();

            // Emit query via message bus
            const sent = messageBus.sendStatusQuery(requestId, targetSessionId);
            if (!sent) {
                return ok("Error: Not connected to relay. Cannot query session status.", {
                    sessionId: targetSessionId,
                    status: "unknown",
                    error: "not_connected",
                });
            }

            // Await response with 5s timeout
            const result = await new Promise<{ requestId: string; status: unknown | null } | null>(
                (resolve) => {
                    const timer = setTimeout(() => {
                        messageBus.removeStatusResponseListener(requestId);
                        resolve(null);
                    }, 5000);

                    messageBus.onStatusResponse(requestId, (data) => {
                        clearTimeout(timer);
                        resolve(data);
                    });
                },
            );

            if (!result || result.status === null) {
                return ok(
                    `Session ${targetSessionId} not found or query timed out.`,
                    {
                        sessionId: targetSessionId,
                        status: "unknown",
                        error: result === null ? "timeout" : "not_found",
                    },
                );
            }

            const status = result.status as Record<string, unknown>;
            const lines = [
                `Session: ${status.sessionId}`,
                `Status: ${status.status}`,
                status.sessionName ? `Name: ${status.sessionName}` : null,
                status.model ? `Model: ${status.model}` : null,
                status.parentSessionId ? `Parent: ${status.parentSessionId}` : null,
                Array.isArray(status.childSessionIds) && status.childSessionIds.length > 0
                    ? `Children: ${(status.childSessionIds as string[]).join(", ")}`
                    : null,
                status.lastActivity ? `Last Activity: ${status.lastActivity}` : null,
            ].filter(Boolean);

            return ok(lines.join("\n"), status);
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── emit ────────────────────────────────────────────────────────────────
    // Broadcasts a message to all sessions in this session's family tree.
    // Family channels are automatically set up when sessions are spawned —
    // no manual channel_join required.
    pi.registerTool({
        name: "emit",
        label: "Emit to Family",
        description:
            "Broadcast a message to all sessions in your family tree (parent, " +
            "children, and siblings). Family channels are automatically set up " +
            "when sessions are spawned — no setup required. Use this to share " +
            "status updates, progress, or coordinate work across related sessions.",
        parameters: {
            type: "object",
            properties: {
                message: {
                    type: "string",
                    description: "The message to broadcast to the family tree.",
                },
            },
            required: ["message"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { message: string };
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const message = params.message?.trim();
            if (!message) {
                return ok("Error: message is required.");
            }

            const count = messageBus.emitToFamily(message);
            if (count === 0) {
                return ok(
                    "No family channels to emit to. This session has no parent or children connected.",
                    { emitted: false, channelCount: 0 },
                );
            }

            return ok(
                `Message emitted to ${count} family channel(s).`,
                { emitted: true, channelCount: count },
            );
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── set_delivery_mode ─────────────────────────────────────────────────────
    pi.registerTool({
        name: "set_delivery_mode",
        label: "Set Delivery Mode",
        description:
            "Configure how incoming inter-agent messages are delivered to this session. " +
            "Modes: 'immediate' — inject messages as soon as they arrive (interrupts current work), " +
            "'queued' — queue messages and deliver them after the current turn ends, " +
            "'blocked' — only deliver messages when explicitly requested via wait_for_message/check_messages.",
        parameters: {
            type: "object",
            properties: {
                mode: {
                    type: "string",
                    enum: ["immediate", "queued", "blocked"],
                    description: "The delivery mode to set.",
                },
            },
            required: ["mode"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { mode: string };
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const mode = params.mode?.trim();
            if (!mode || !["immediate", "queued", "blocked"].includes(mode)) {
                return ok("Error: mode must be one of 'immediate', 'queued', or 'blocked'.");
            }

            // TODO: The underlying delivery mode infrastructure is being built in
            // session-message-bus.ts (PizzaPi-7x0.4). Once that's complete, call:
            //   messageBus.setDeliveryMode(mode as "immediate" | "queued" | "blocked");
            // For now, we call it directly since PizzaPi-7x0.4 may have landed.
            if (typeof (messageBus as any).setDeliveryMode === "function") {
                (messageBus as any).setDeliveryMode(mode);
                return ok(`Delivery mode set to '${mode}'.`, { mode });
            }

            return ok(
                `Delivery mode '${mode}' acknowledged but infrastructure not yet available. ` +
                `This will take effect once the message delivery system is fully wired up.`,
                { mode, pending: true },
            );
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });
};
