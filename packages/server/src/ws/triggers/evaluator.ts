// ============================================================================
// Trigger evaluator — processes events and fires matching triggers
// ============================================================================

import type {
    TriggerNotification,
    TriggerRecord,
    TriggerDelivery,
    TriggerType,
    SessionTriggerConfig,
    CostTriggerConfig,
    CustomEventTriggerConfig,
    TimerTriggerConfig,
} from "@pizzapi/protocol";
import type { TriggerRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback invoked to deliver a trigger notification to the owning session.
 * The relay handler wires this up to emit Socket.IO events.
 */
export type NotificationDeliveryFn = (
    ownerSessionId: string,
    notification: TriggerNotification,
    delivery: TriggerDelivery,
) => void;

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * Interpolate placeholders in a message template.
 * Supported: {sessionId}, {sourceSessionId}, {eventName}, {payload}, {cost}, {error}, {threshold}
 */
export function interpolateMessage(template: string, vars: Record<string, unknown>): string {
    return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
        const val = vars[key];
        if (val === undefined || val === null) return `{${key}}`;
        if (typeof val === "object") {
            try {
                return JSON.stringify(val);
            } catch {
                return String(val);
            }
        }
        return String(val);
    });
}

// ---------------------------------------------------------------------------
// Session-ID matching helper
// ---------------------------------------------------------------------------

function sessionIdMatches(config: { sessionIds: string[] | "*" }, sessionId: string): boolean {
    if (config.sessionIds === "*") return true;
    return Array.isArray(config.sessionIds) && config.sessionIds.includes(sessionId);
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class TriggerEvaluator {
    /**
     * Tracks per-session active state for idle transition detection.
     * Key: sessionId, Value: last known active state.
     */
    private sessionActiveStates = new Map<string, boolean>();

    constructor(
        private registry: TriggerRegistry,
        private deliver: NotificationDeliveryFn,
    ) {}

    // ── Session-ended ─────────────────────────────────────────────────────

    async evaluateSessionEnded(runnerId: string, sessionId: string): Promise<void> {
        const triggers = await this.registry.getTriggersByType(runnerId, "session_ended");
        await this.evaluateSessionTriggers(triggers, sessionId, "session_ended", { sessionId });
        // Clean up idle tracking for this session
        this.sessionActiveStates.delete(sessionId);
    }

    // ── Session-error ─────────────────────────────────────────────────────

    async evaluateSessionError(runnerId: string, sessionId: string, errorMessage: string): Promise<void> {
        const triggers = await this.registry.getTriggersByType(runnerId, "session_error");
        await this.evaluateSessionTriggers(triggers, sessionId, "session_error", {
            sessionId,
            error: errorMessage,
        });
    }

    // ── Heartbeat (cost_exceeded + session_idle) ──────────────────────────

    async evaluateHeartbeat(
        runnerId: string,
        sessionId: string,
        heartbeatData: { cost?: number; isActive?: boolean },
    ): Promise<void> {
        // Cost exceeded
        if (heartbeatData.cost !== undefined) {
            const costTriggers = await this.registry.getTriggersByType(runnerId, "cost_exceeded");
            for (const trigger of costTriggers) {
                const config = trigger.config as CostTriggerConfig;
                if (!sessionIdMatches(config, sessionId)) continue;
                if (heartbeatData.cost < config.threshold) continue;

                await this.fireAndDeliver(trigger, {
                    sessionId,
                    cost: heartbeatData.cost,
                    threshold: config.threshold,
                });
            }
        }

        // Idle detection — fire only on active → idle transition
        if (heartbeatData.isActive !== undefined) {
            const wasActive = this.sessionActiveStates.get(sessionId);
            this.sessionActiveStates.set(sessionId, heartbeatData.isActive);

            if (wasActive === true && heartbeatData.isActive === false) {
                const idleTriggers = await this.registry.getTriggersByType(runnerId, "session_idle");
                await this.evaluateSessionTriggers(idleTriggers, sessionId, "session_idle", { sessionId });
            }
        }
    }

    // ── Custom event ──────────────────────────────────────────────────────

    async evaluateCustomEvent(
        runnerId: string,
        sourceSessionId: string,
        eventName: string,
        payload?: unknown,
    ): Promise<void> {
        const triggers = await this.registry.getTriggersByType(runnerId, "custom_event");
        for (const trigger of triggers) {
            const config = trigger.config as CustomEventTriggerConfig;
            if (config.eventName !== eventName) continue;
            if (config.fromSessionIds !== "*" && !config.fromSessionIds.includes(sourceSessionId)) continue;

            await this.fireAndDeliver(trigger, {
                sessionId: sourceSessionId,
                sourceSessionId,
                eventName,
                payload,
            });
        }
    }

    // ── Timer (called by TimerScheduler) ──────────────────────────────────

    async fireTimerTrigger(triggerId: string): Promise<void> {
        const record = await this.registry.fireTrigger(triggerId);
        if (!record) return; // expired or already removed

        const config = record.config as TimerTriggerConfig;
        const notification = this.buildNotification(record, {
            sessionId: record.ownerSessionId,
            delaySec: config.delaySec,
        });

        this.deliver(record.ownerSessionId, notification, record.delivery);
    }

    // ── Idle state management ─────────────────────────────────────────────

    /** Set session active state (useful for initialization). */
    setSessionActive(sessionId: string, isActive: boolean): void {
        this.sessionActiveStates.set(sessionId, isActive);
    }

    /** Remove session tracking on disconnect. */
    removeSessionState(sessionId: string): void {
        this.sessionActiveStates.delete(sessionId);
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    private async evaluateSessionTriggers(
        triggers: TriggerRecord[],
        sessionId: string,
        _type: TriggerType,
        vars: Record<string, unknown>,
    ): Promise<void> {
        for (const trigger of triggers) {
            const config = trigger.config as SessionTriggerConfig;
            if (!sessionIdMatches(config, sessionId)) continue;
            await this.fireAndDeliver(trigger, vars);
        }
    }

    private async fireAndDeliver(
        trigger: TriggerRecord,
        vars: Record<string, unknown>,
    ): Promise<void> {
        const record = await this.registry.fireTrigger(trigger.id);
        if (!record) return; // expired, maxFirings reached, or removed

        const notification = this.buildNotification(record, vars);
        this.deliver(record.ownerSessionId, notification, record.delivery);
    }

    private buildNotification(
        trigger: TriggerRecord,
        vars: Record<string, unknown>,
    ): TriggerNotification {
        const message = trigger.message
            ? interpolateMessage(trigger.message, vars)
            : `Trigger ${trigger.type} fired`;

        return {
            triggerId: trigger.id,
            triggerType: trigger.type,
            message,
            sourceSessionId: typeof vars.sourceSessionId === "string" ? vars.sourceSessionId : undefined,
            payload: vars.payload,
            firedAt: new Date().toISOString(),
        };
    }
}
