// ============================================================================
// Trigger system singletons — shared between relay and viewer namespaces
// ============================================================================

import type { TriggerNotification, TriggerDelivery } from "@pizzapi/protocol";
import { TriggerRegistry, TriggerEvaluator, TimerScheduler } from "./index.js";
import { getActiveRedisClient } from "../../sessions/redis.js";
import { getLocalTuiSocket, broadcastToViewers } from "../sio-registry.js";

// ── Singleton instances ──────────────────────────────────────────────────────

export const triggerRegistry = new TriggerRegistry(() => getActiveRedisClient());

/** Broadcast the current trigger list to all viewers of a session. */
export async function broadcastTriggersToViewers(sessionId: string): Promise<void> {
    const triggers = await triggerRegistry.listTriggers(sessionId);
    broadcastToViewers(sessionId, "trigger_list", { triggers });
}

/** Broadcast a trigger_fired event to all viewers of a session. */
export function broadcastTriggerFiredToViewers(
    ownerSessionId: string,
    notification: TriggerNotification,
    delivery: TriggerDelivery,
    triggers: import("@pizzapi/protocol").TriggerRecord[],
): void {
    broadcastToViewers(ownerSessionId, "trigger_fired", {
        ...notification,
        delivery,
        triggers,
    });
}

/** Deliver a trigger notification to the owning session's TUI socket. */
function deliverTriggerNotification(
    ownerSessionId: string,
    notification: TriggerNotification,
    delivery: TriggerDelivery,
): void {
    const targetSocket = getLocalTuiSocket(ownerSessionId);
    if (!targetSocket) return;

    if (delivery.mode === "inject") {
        targetSocket.emit("trigger_fired" as any, { ...notification, delivery });
    } else {
        // queue mode — deliver as a session_message so it appears in check_messages/wait_for_message
        targetSocket.emit("session_message" as string, {
            fromSessionId: notification.sourceSessionId ?? "trigger",
            message: `[Trigger: ${notification.triggerType}] ${notification.message}`,
            ts: notification.firedAt,
        });
    }

    // Broadcast trigger_fired to viewers for real-time UI updates
    void (async () => {
        const triggers = await triggerRegistry.listTriggers(ownerSessionId);
        broadcastTriggerFiredToViewers(ownerSessionId, notification, delivery, triggers);
    })();

    // Also broadcast updated trigger list (for trigger panel state)
    void broadcastTriggersToViewers(ownerSessionId);
}

export const triggerEvaluator = new TriggerEvaluator(triggerRegistry, deliverTriggerNotification);

export const timerScheduler = new TimerScheduler(
    triggerRegistry,
    (triggerId) => triggerEvaluator.fireTimerTrigger(triggerId),
);
