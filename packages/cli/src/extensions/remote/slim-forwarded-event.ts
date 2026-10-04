/**
 * Drop Pi event fields no viewer reads before they hit the relay. Both events
 * below are durable relay events buffered in Redis, so oversized fields there
 * multiply across the event buffer (2026-10-03 Redis OOM).
 *
 * - tool_execution_end: Pi 1.0 `result.structuredContent` (bash: up to 1 MiB of
 *   full output, for programmatic callers such as codemode).
 * - turn_end: Pi 0.87+ BoundaryState `context` (contextEntries/contextMessages/
 *   llmMessages: full-transcript copies, ~6 MB observed), `entries`, and
 *   `toolResults` (already sent as their own message_end events). Viewers and
 *   the relay only read `turn_end.message`.
 *
 * Returns a copy; never mutates Pi's event.
 */
export function slimForwardedEvent<T>(event: T): T {
    const e = event as any;
    if (e?.type === "turn_end") {
        const { context: _c, entries: _e, toolResults: _t, ...rest } = e;
        return rest;
    }
    const result = e?.result;
    if (e?.type === "tool_execution_end" && result && typeof result === "object" && "structuredContent" in result) {
        const { structuredContent: _omit, ...rest } = result;
        return { ...e, result: rest };
    }
    return event;
}
