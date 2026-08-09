import type { ConversationTrigger } from "../triggers/types.js";

const listeners = new Set<(trigger: ConversationTrigger) => void>();

/** Subscribe to valid triggers delivered by the relay to this session. */
export function onRelayTrigger(listener: (trigger: ConversationTrigger) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifyRelayTrigger(trigger: ConversationTrigger): void {
    for (const listener of listeners) {
        try {
            listener(trigger);
        } catch (err) {
            console.error("Relay trigger listener failed:", err);
        }
    }
}
