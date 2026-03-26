import type { HookEntry, HookMatcher } from "../../config.js";
import type { HookOutput } from "./types.js";
import { matchesTool } from "./matcher.js";
import { runHook, parseHookOutput } from "./runner.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("hooks");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect all matching hook entries for a given event type and tool name. */
export function getMatchingHooks(matchers: HookMatcher[] | undefined, toolName: string): HookEntry[] {
    if (!matchers) return [];
    const entries: HookEntry[] = [];
    for (const m of matchers) {
        if (matchesTool(m.matcher, toolName)) {
            entries.push(...m.hooks);
        }
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Shared helpers for event hooks
// ---------------------------------------------------------------------------

/**
 * Run all hook entries for an event, returning early on block/kill.
 * Used by cancelable events (Input, UserBash, SessionBefore*).
 *
 * Returns { blocked, reason, outputs } where outputs contains parsed
 * JSON from successful hooks.
 */
export async function runEventHooks(
    hooks: HookEntry[],
    payload: string,
    cwd: string,
    eventName: string,
): Promise<{ blocked: boolean; reason?: string; outputs: HookOutput[] }> {
    const outputs: HookOutput[] = [];
    for (const hook of hooks) {
        const result = await runHook(hook, payload, cwd);

        // Killed (timeout / signal) → fail-closed for safety
        if (result.killed) {
            return {
                blocked: true,
                reason: `${eventName} hook timed out — blocking for safety.`,
                outputs,
            };
        }

        // Exit 2 = hard block / cancel
        if (result.exitCode === 2) {
            return {
                blocked: true,
                reason: result.stderr || `Blocked by ${eventName} hook`,
                outputs,
            };
        }

        // Exit 0 with JSON output
        if (result.exitCode === 0 && result.stdout) {
            const output = parseHookOutput(result.stdout);
            if (output) outputs.push(output);
        }

        // Non-zero exit (other than 2) → fail-closed
        if (result.exitCode !== 0) {
            return {
                blocked: true,
                reason: result.stderr || `${eventName} hook exited with code ${result.exitCode}`,
                outputs,
            };
        }
    }
    return { blocked: false, outputs };
}

/**
 * Run all hook entries for a fire-and-forget event (SessionShutdown, ModelSelect).
 * Errors are logged but never block anything.
 */
export async function runFireAndForgetHooks(
    hooks: HookEntry[],
    payload: string,
    cwd: string,
    eventName: string,
): Promise<void> {
    for (const hook of hooks) {
        try {
            await runHook(hook, payload, cwd);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`${eventName} handler error: ${msg}`);
        }
    }
}
