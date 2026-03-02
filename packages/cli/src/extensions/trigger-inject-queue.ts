/**
 * Trigger inject queue.
 *
 * Singleton FIFO queue that holds trigger notifications destined for "inject"
 * delivery. Notifications are enqueued when `trigger_fired` events arrive from
 * the relay with `delivery.mode === "inject"`. They are drained just before the
 * agent's next turn (in the BeforeAgentStart hook) and prepended as
 * additionalContext.
 */

import type { TriggerNotification } from "@pizzapi/protocol";

class TriggerInjectQueue {
    private queue: TriggerNotification[] = [];

    /** Add a notification to the inject queue. */
    enqueue(notification: TriggerNotification): void {
        this.queue.push(notification);
    }

    /** Remove and return all queued notifications. */
    drain(): TriggerNotification[] {
        const items = this.queue.slice();
        this.queue.length = 0;
        return items;
    }

    /** True if the queue has no notifications. */
    isEmpty(): boolean {
        return this.queue.length === 0;
    }

    /** Number of queued notifications. */
    size(): number {
        return this.queue.length;
    }
}

/** Singleton instance shared between remote extension and hooks extension. */
export const triggerInjectQueue = new TriggerInjectQueue();

/**
 * Format drained trigger notifications as additional context for the agent.
 * Each notification becomes a single line: `[Trigger: {type}] {message}`
 */
export function formatTriggerNotifications(notifications: TriggerNotification[]): string {
    if (notifications.length === 0) return "";
    return notifications
        .map((n) => `[Trigger: ${n.triggerType}] ${n.message}`)
        .join("\n");
}
