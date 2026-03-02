// ============================================================================
// TimerScheduler — Manages timer-type trigger scheduling
// ============================================================================

import type { TriggerRecord, TimerTriggerConfig } from "@pizzapi/protocol";
import type { TriggerRegistry } from "./registry.js";

const MIN_TIMER_DELAY_SEC = 0.001;

export type TimerFireFn = (triggerId: string) => Promise<void>;

export class TimerScheduler {
    private activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private registry: TriggerRegistry,
        private onFire: TimerFireFn,
    ) {}

    private getValidDelayMs(config: TimerTriggerConfig): number | null {
        const { delaySec } = config;
        if (!Number.isFinite(delaySec) || delaySec < MIN_TIMER_DELAY_SEC) {
            return null;
        }
        return delaySec * 1000;
    }

    private checkAndCancelIfRemoved(triggerId: string): void {
        void this.registry.hasTrigger(triggerId).then((exists) => {
            if (!exists) {
                this.cancelTimer(triggerId);
            }
        }).catch(() => {
            // Best-effort safety check; ignore Redis read failures.
        });
    }

    // -------------------------------------------------------------------------
    // scheduleTimer
    // -------------------------------------------------------------------------

    /** Schedule a timer for a trigger. Call after registering a timer trigger. */
    scheduleTimer(trigger: TriggerRecord): void {
        // Replace existing handle if this trigger was already scheduled.
        this.cancelTimer(trigger.id);

        const config = trigger.config as TimerTriggerConfig;
        const { recurring } = config;
        const delayMs = this.getValidDelayMs(config);

        if (delayMs === null) {
            console.warn(`[triggers/timers] Skipping timer ${trigger.id}: invalid delaySec`);
            return;
        }

        if (recurring) {
            const handle = setInterval(() => {
                void this.onFire(trigger.id)
                    .then(() => this.checkAndCancelIfRemoved(trigger.id));
            }, delayMs);
            this.activeTimers.set(trigger.id, handle);
        } else {
            const handle = setTimeout(() => {
                // One-shot: remove from map before firing
                this.activeTimers.delete(trigger.id);
                void this.onFire(trigger.id);
            }, delayMs);
            this.activeTimers.set(trigger.id, handle);
        }
    }

    // -------------------------------------------------------------------------
    // cancelTimer
    // -------------------------------------------------------------------------

    /** Cancel a scheduled timer. Call after cancelling a trigger. */
    cancelTimer(triggerId: string): void {
        const handle = this.activeTimers.get(triggerId);
        if (handle !== undefined) {
            // clearTimeout works for both setTimeout and setInterval handles
            clearTimeout(handle);
            this.activeTimers.delete(triggerId);
        }
    }

    // -------------------------------------------------------------------------
    // rehydrateTimers
    // -------------------------------------------------------------------------

    /** Rehydrate timers from Redis on server restart. */
    async rehydrateTimers(runnerId: string): Promise<void> {
        const triggers = await this.registry.getTriggersByType(runnerId, "timer");
        const now = Date.now();

        for (const trigger of triggers) {
            const config = trigger.config as TimerTriggerConfig;
            const { recurring } = config;
            const delayMs = this.getValidDelayMs(config);

            if (delayMs === null) {
                continue;
            }

            if (recurring) {
                // Calculate time since last fire (fall back to creation time)
                const baseTime = trigger.lastFiredAt
                    ? new Date(trigger.lastFiredAt).getTime()
                    : new Date(trigger.createdAt).getTime();
                const elapsed = now - baseTime;

                if (elapsed >= delayMs) {
                    // Overdue — fire immediately, then schedule recurring interval
                    void this.onFire(trigger.id);
                    const handle = setInterval(() => {
                        void this.onFire(trigger.id)
                            .then(() => this.checkAndCancelIfRemoved(trigger.id));
                    }, delayMs);
                    this.activeTimers.set(trigger.id, handle);
                } else {
                    // Not overdue — schedule remaining time, then switch to recurring
                    const remaining = delayMs - elapsed;
                    const firstHandle = setTimeout(() => {
                        void this.onFire(trigger.id);
                        // Switch to a full recurring interval after the first fire
                        const intervalHandle = setInterval(() => {
                            void this.onFire(trigger.id)
                                .then(() => this.checkAndCancelIfRemoved(trigger.id));
                        }, delayMs);
                        this.activeTimers.set(trigger.id, intervalHandle);
                    }, remaining);
                    this.activeTimers.set(trigger.id, firstHandle);
                }
            } else {
                // One-shot: calculate remaining time based on creation
                const createdTime = new Date(trigger.createdAt).getTime();
                const elapsed = now - createdTime;
                const remaining = delayMs - elapsed;

                if (remaining <= 0) {
                    // Overdue — fire immediately, no timer scheduled
                    void this.onFire(trigger.id);
                } else {
                    // Schedule with the remaining delay
                    const handle = setTimeout(() => {
                        this.activeTimers.delete(trigger.id);
                        void this.onFire(trigger.id);
                    }, remaining);
                    this.activeTimers.set(trigger.id, handle);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // cleanupSessionTimers
    // -------------------------------------------------------------------------

    /** Cancel all timers for a session (cleanup on disconnect). */
    cleanupSessionTimers(sessionId: string, triggers: TriggerRecord[]): void {
        const sessionTriggers = triggers.filter((t) => t.ownerSessionId === sessionId);
        for (const trigger of sessionTriggers) {
            this.cancelTimer(trigger.id);
        }
    }

    // -------------------------------------------------------------------------
    // Accessors
    // -------------------------------------------------------------------------

    /** Check if a timer is active */
    isActive(triggerId: string): boolean {
        return this.activeTimers.has(triggerId);
    }

    /** Get count of active timers */
    get activeCount(): number {
        return this.activeTimers.size;
    }
}
