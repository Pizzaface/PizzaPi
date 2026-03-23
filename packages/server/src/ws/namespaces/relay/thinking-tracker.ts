// ── Thinking-block duration tracking ─────────────────────────────────────────
// Keyed by sessionId → contentIndex → value.
// We record the wall-clock time when thinking_start arrives, compute elapsed
// seconds when thinking_end arrives, then bake durationSeconds into the
// message_end / turn_end event before it is published to Redis / viewers.

export const thinkingStartTimes = new Map<string, Map<number, number>>();
export const thinkingDurations = new Map<string, Map<number, number>>();

export function clearThinkingMaps(sessionId: string): void {
    thinkingStartTimes.delete(sessionId);
    thinkingDurations.delete(sessionId);
}

/** Stamp `durationSeconds` onto thinking blocks in a message_end / turn_end event. */
export function augmentMessageThinkingDurations(
    event: Record<string, unknown>,
    durations: Map<number, number>,
): Record<string, unknown> {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return event;

    let changed = false;
    const content = (message.content as unknown[]).map((block, i) => {
        if (!block || typeof block !== "object") return block;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking" && durations.has(i) && b.durationSeconds === undefined) {
            changed = true;
            return { ...b, durationSeconds: durations.get(i) };
        }
        return block;
    });

    if (!changed) return event;
    return { ...event, message: { ...message, content } };
}

export function trackThinkingDeltas(sessionId: string, event: Record<string, unknown>): void {
    if (event.type !== "message_update") return;

    const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!ae) return;

    const deltaType = typeof ae.type === "string" ? ae.type : "";
    const contentIndex = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
    if (contentIndex < 0) return;

    if (deltaType === "thinking_start") {
        if (!thinkingStartTimes.has(sessionId)) thinkingStartTimes.set(sessionId, new Map());
        thinkingStartTimes.get(sessionId)!.set(contentIndex, Date.now());
    } else if (deltaType === "thinking_end") {
        const startTime = thinkingStartTimes.get(sessionId)?.get(contentIndex);
        if (startTime !== undefined) {
            const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
            if (!thinkingDurations.has(sessionId)) thinkingDurations.set(sessionId, new Map());
            thinkingDurations.get(sessionId)!.set(contentIndex, durationSeconds);
            thinkingStartTimes.get(sessionId)?.delete(contentIndex);
        }
    }
}
