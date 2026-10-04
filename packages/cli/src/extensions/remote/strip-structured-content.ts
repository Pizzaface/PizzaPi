/**
 * Pi 1.0 adds `result.structuredContent` to tool_execution_end (bash: up to
 * 1 MiB of full output) for programmatic callers such as codemode. No viewer
 * reads it, and tool_execution_end is a durable relay event cached in Redis,
 * so drop it before forwarding. Returns a copy; never mutates Pi's event.
 */
export function stripStructuredContent<T>(event: T): T {
    const result = (event as any)?.result;
    if ((event as any)?.type !== "tool_execution_end" || !result || typeof result !== "object" || !("structuredContent" in result)) {
        return event;
    }
    const { structuredContent: _omit, ...rest } = result;
    return { ...(event as any), result: rest };
}
