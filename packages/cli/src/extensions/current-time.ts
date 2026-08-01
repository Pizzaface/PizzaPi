import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Current-time extension — a tool the model can call to get the current date
 * and time. The system prompt's timestamp is frozen at session start, so
 * long-running sessions need this to know the actual current time.
 */
/** Format a Date as the tool's response text: local time, ISO UTC, and timezone. */
export function formatCurrentTime(now: Date): string {
    const local = now.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
    });
    return [
        `Local: ${local}`,
        `ISO (UTC): ${now.toISOString()}`,
        `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ].join("\n");
}

export const currentTimeExtension: ExtensionFactory = (pi) => {
    pi.registerTool({
        name: "get_current_time",
        label: "Get Current Time",
        description:
            "Get the current date and time. Returns the local time, ISO 8601 UTC timestamp, and timezone. Use this when you need the actual current time — the timestamp in the system prompt is from session start and may be stale.",
        parameters: {
            type: "object",
            properties: {},
        } as any,
        execute: async () => ({
            content: [{ type: "text" as const, text: formatCurrentTime(new Date()) }],
            details: undefined,
        }),
    });
};
