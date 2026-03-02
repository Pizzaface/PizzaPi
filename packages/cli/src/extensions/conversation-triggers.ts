import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { TriggerConfig, TriggerDelivery, TriggerRecord, TriggerType } from "@pizzapi/protocol";
import { triggerBus, type RegisterTriggerParams } from "./trigger-bus.js";

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * Conversation Triggers extension — provides tools for agents to set up
 * automated triggers based on session events, timers, cost thresholds, and
 * custom pub/sub events.
 *
 * Tools:
 *   register_trigger  — Register a trigger that fires when a condition is met
 *   cancel_trigger    — Cancel a previously registered trigger
 *   list_triggers     — List all active triggers registered by this session
 *   emit_event        — Emit a custom event for pub/sub coordination
 */
export const conversationTriggersExtension: ExtensionFactory = (pi) => {
    // ── register_trigger ───────────────────────────────────────────────────
    pi.registerTool({
        name: "register_trigger",
        label: "Register Trigger",
        description:
            "Register a trigger that fires when a condition is met. " +
            "Trigger types: 'session_ended' (fires when target sessions end), " +
            "'session_error' (fires on session errors), " +
            "'session_idle' (fires when sessions go idle), " +
            "'cost_exceeded' (fires when session cost exceeds a threshold), " +
            "'custom_event' (fires when a named event is emitted via emit_event), " +
            "'timer' (fires after a delay, optionally recurring). " +
            "Returns the trigger ID.",
        parameters: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["session_ended", "session_idle", "session_error", "cost_exceeded", "custom_event", "timer"],
                    description:
                        "The type of trigger condition. " +
                        "'session_ended' | 'session_idle' | 'session_error': requires config.sessionIds. " +
                        "'cost_exceeded': requires config.sessionIds and config.threshold. " +
                        "'custom_event': requires config.eventName and config.fromSessionIds. " +
                        "'timer': requires config.delaySec; optional config.recurring.",
                },
                config: {
                    type: "object",
                    description:
                        "Type-specific configuration object. " +
                        "For session_ended/session_idle/session_error: { sessionIds: string[] | '*' }. " +
                        "For cost_exceeded: { sessionIds: string[] | '*', threshold: number }. " +
                        "For custom_event: { eventName: string, fromSessionIds: string[] | '*' }. " +
                        "For timer: { delaySec: number, recurring?: boolean }.",
                },
                delivery: {
                    type: "object",
                    properties: {
                        mode: {
                            type: "string",
                            enum: ["queue", "inject"],
                            description: "'inject' injects the message directly into the running conversation (default). 'queue' enqueues it for when the session next runs.",
                        },
                    },
                    description: "Delivery mode for the trigger message. Defaults to inject.",
                },
                message: {
                    type: "string",
                    description:
                        "Message template sent to the owning session when the trigger fires. " +
                        "Supports placeholders: {sessionId}, {eventName}, {threshold}.",
                },
                maxFirings: {
                    type: "number",
                    description: "Maximum number of times the trigger can fire. Omit for unlimited.",
                },
                expiresAt: {
                    type: "string",
                    description: "ISO 8601 timestamp after which the trigger is automatically removed, e.g. '2026-04-01T00:00:00Z'.",
                },
            },
            required: ["type", "config"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const params = (rawParams ?? {}) as {
                type: TriggerType;
                config: TriggerConfig;
                delivery?: TriggerDelivery;
                message?: string;
                maxFirings?: number;
                expiresAt?: string;
            };

            if (!params.type) {
                return ok("Error: 'type' is required.");
            }
            if (!params.config || typeof params.config !== "object") {
                return ok("Error: 'config' is required and must be an object.");
            }

            const registerParams: RegisterTriggerParams = {
                type: params.type,
                config: params.config,
                delivery: params.delivery,
                message: params.message,
                maxFirings: params.maxFirings,
                expiresAt: params.expiresAt,
            };

            try {
                const result = await triggerBus.register(registerParams);
                return ok(
                    `Trigger registered successfully. ID: ${result.triggerId} (type: ${result.type})`,
                    { triggerId: result.triggerId, type: result.type },
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error registering trigger: ${message}`);
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── cancel_trigger ─────────────────────────────────────────────────────
    pi.registerTool({
        name: "cancel_trigger",
        label: "Cancel Trigger",
        description: "Cancel a previously registered trigger by its ID.",
        parameters: {
            type: "object",
            properties: {
                triggerId: {
                    type: "string",
                    description: "The ID of the trigger to cancel, as returned by register_trigger.",
                },
            },
            required: ["triggerId"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const params = (rawParams ?? {}) as { triggerId: string };

            if (!params.triggerId?.trim()) {
                return ok("Error: 'triggerId' is required.");
            }

            try {
                const result = await triggerBus.cancel(params.triggerId.trim());
                return ok(
                    `Trigger ${result.triggerId} cancelled successfully.`,
                    { triggerId: result.triggerId },
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error cancelling trigger: ${message}`);
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── list_triggers ──────────────────────────────────────────────────────
    pi.registerTool({
        name: "list_triggers",
        label: "List Triggers",
        description: "List all active triggers registered by this session.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        } as any,

        async execute(_toolCallId, _rawParams) {
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            try {
                const result = await triggerBus.list();
                const triggers = result.triggers;

                if (triggers.length === 0) {
                    return ok("No active triggers.", { triggers: [], count: 0 });
                }

                const formatted = triggers
                    .map((t: TriggerRecord) => {
                        const parts = [`[${t.id}] type=${t.type}`];
                        if (t.maxFirings !== undefined) parts.push(`maxFirings=${t.maxFirings}`);
                        parts.push(`fired=${t.firingCount}`);
                        if (t.expiresAt) parts.push(`expiresAt=${t.expiresAt}`);
                        return parts.join(", ");
                    })
                    .join("\n");

                return ok(
                    `${triggers.length} active trigger(s):\n\n${formatted}`,
                    { triggers, count: triggers.length },
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error listing triggers: ${message}`);
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── emit_event ─────────────────────────────────────────────────────────
    pi.registerTool({
        name: "emit_event",
        label: "Emit Event",
        description:
            "Emit a custom event that can trigger other sessions' custom_event triggers. " +
            "Use for pub/sub coordination between agent sessions.",
        parameters: {
            type: "object",
            properties: {
                eventName: {
                    type: "string",
                    description: "The name of the event to emit. Other sessions can listen for this via a 'custom_event' trigger with config.eventName matching this value.",
                },
                payload: {
                    type: "object",
                    description: "Optional JSON payload to include with the event.",
                },
            },
            required: ["eventName"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const params = (rawParams ?? {}) as { eventName: string; payload?: unknown };

            if (!params.eventName?.trim()) {
                return ok("Error: 'eventName' is required.");
            }

            const sent = triggerBus.emit(params.eventName.trim(), params.payload);
            if (!sent) {
                return ok("Error: Not connected to relay. Cannot emit events without a relay connection.");
            }

            return ok(
                `Event '${params.eventName.trim()}' emitted.`,
                { eventName: params.eventName.trim(), payload: params.payload ?? null },
            );
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });
};
