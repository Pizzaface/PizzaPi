let activeSlots = 0;
let followUpStarted = false;
const idleListeners = new Set<(followUpStarted: boolean) => void>();

export function hasActiveSubagents(): boolean {
    return activeSlots > 0;
}

export function onSubagentsIdle(listener: (followUpStarted: boolean) => void): () => void {
    idleListeners.add(listener);
    return () => idleListeners.delete(listener);
}

export function noteSubagentSettlementDeferred(): void {
    followUpStarted = false;
}

export function reserveSubagentSlots(count: number, max: number): ((startedFollowUp?: boolean) => void) | undefined {
    if (activeSlots + count > max) return undefined;
    activeSlots += count;
    let released = false;
    return (startedFollowUp = false) => {
        if (released) return;
        released = true;
        followUpStarted ||= startedFollowUp;
        activeSlots -= count;
        if (activeSlots !== 0) return;

        const didStartFollowUp = followUpStarted;
        followUpStarted = false;
        for (const listener of idleListeners) {
            try {
                listener(didStartFollowUp);
            } catch (err) {
                console.error("Subagent idle listener failed:", err);
            }
        }
    };
}

export function resetSubagentState(): void {
    activeSlots = 0;
    followUpStarted = false;
    idleListeners.clear();
}

/**
 * Reset the slot counters WITHOUT dropping idle listeners.
 *
 * Used on `/new` (session reset in place): the conversation restarts but the
 * extension — and the lifecycle handler's onSubagentsIdle listener that gates
 * session completion — lives on, so its listener must survive.
 */
export function resetSubagentCounters(): void {
    activeSlots = 0;
    followUpStarted = false;
}
