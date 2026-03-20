import { basename } from "node:path";
import type { RunnerHook } from "@pizzapi/protocol";
import type { HooksConfig } from "../config.js";

/**
 * Summarise the active hooks from a HooksConfig for display in the web UI.
 * Returns one entry per hook type that has at least one configured command.
 * Scripts are represented by the basename of the first token in the command string.
 */
export function extractHookSummary(hooks?: HooksConfig): RunnerHook[] {
    if (!hooks) return [];
    const result: RunnerHook[] = [];

    // Matcher-based hooks (PreToolUse / PostToolUse)
    for (const type of ["PreToolUse", "PostToolUse"] as const) {
        const matchers = hooks[type] ?? [];
        const scripts: string[] = [];
        for (const m of matchers) {
            for (const h of m.hooks) {
                const cmd = h.command.trim().split(/\s+/)[0];
                if (cmd) scripts.push(basename(cmd));
            }
        }
        if (scripts.length > 0) result.push({ type, scripts });
    }

    // Entry-based hooks
    const entryTypes = [
        "Input",
        "BeforeAgentStart",
        "UserBash",
        "SessionBeforeSwitch",
        "SessionBeforeFork",
        "SessionShutdown",
        "SessionBeforeCompact",
        "SessionBeforeTree",
        "ModelSelect",
    ] as const;
    for (const type of entryTypes) {
        const entries = (hooks[type] as { command: string }[] | undefined) ?? [];
        const scripts: string[] = [];
        for (const h of entries) {
            const cmd = h.command.trim().split(/\s+/)[0];
            if (cmd) scripts.push(basename(cmd));
        }
        if (scripts.length > 0) result.push({ type, scripts });
    }

    return result;
}
