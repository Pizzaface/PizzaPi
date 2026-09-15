import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}
