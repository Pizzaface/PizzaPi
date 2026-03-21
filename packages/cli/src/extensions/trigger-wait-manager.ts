import type { TriggerResponse } from "./remote-types.js";

export interface TriggerWaitManager {
    register(triggerId: string, cancel: (result: TriggerResponse) => void): () => void;
    cancelAll(response: string): number;
    size(): number;
}

export function createTriggerWaitManager(): TriggerWaitManager {
    const waits = new Map<string, (result: TriggerResponse) => void>();

    return {
        register(triggerId: string, cancel: (result: TriggerResponse) => void) {
            waits.set(triggerId, cancel);
            return () => {
                if (waits.get(triggerId) === cancel) waits.delete(triggerId);
            };
        },
        cancelAll(response: string) {
            const pending = [...waits.values()];
            waits.clear();
            for (const cancel of pending) {
                cancel({ response, cancelled: true });
            }
            return pending.length;
        },
        size() {
            return waits.size;
        },
    };
}
