/**
 * Plan-mode (read-only) enforcement for subagent sessions.
 *
 * Subagents run in-process via `createAgentSession` with `noExtensions: true`,
 * so the parent's plan-mode extension (and its `tool_call` guard) is NOT
 * loaded inside the child. Restrictions are therefore enforced structurally,
 * at session construction time, so they hold from the child's very first
 * turn:
 *
 *   1. The child's tool allowlist is reduced to read-only tools
 *      (`read`, `grep`, `find`, `ls`) plus `bash`. `edit` / `write` are never
 *      registered, so the model cannot call them at all.
 *   2. `bash` is replaced (same name, via `customTools`) by a guarded wrapper
 *      that rejects destructive commands with the same detector the parent's
 *      plan mode uses. The full regex battery is always applied — the child
 *      may outlive the parent's plan-mode session (and thus its sandbox
 *      read-only overlay), so it must not rely on OS enforcement.
 *   3. A short plan-mode notice is appended to the child's system prompt so
 *      it knows why writes are unavailable.
 *
 * The plan-mode flag is snapshotted when the parent calls `subagent` and is
 * threaded through every agent the invocation runs (single, parallel, chain
 * steps). Subagent sessions do not load extensions, so they cannot spawn
 * nested subagents or linked sessions — there is no path out of read-only.
 */

import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isDestructiveCommand } from "../plan-mode/safe-command.js";

/** Built-in tools a plan-mode subagent may use. `bash` is always the guarded variant. */
export const PLAN_MODE_SUBAGENT_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

const PLAN_MODE_ALLOWED = new Set<string>(PLAN_MODE_SUBAGENT_TOOLS);

/** Options that change how a single subagent run is executed. */
export interface SubagentRunOptions {
    /**
     * Force the subagent into read-only plan mode. Set automatically by the
     * `subagent` / `run_workflow` tools when the parent session is in plan
     * mode — it is not a model-controllable parameter.
     */
    planMode?: boolean;
}

/**
 * Restrict a requested tool list to the plan-mode-safe set.
 *
 * - `undefined` (agent did not restrict its tools) → every plan-mode tool.
 * - An explicit list → its intersection with the plan-mode set, so an agent
 *   that asked for fewer tools never gains more. May be empty; callers fall
 *   back to `read` so the child still has something to work with.
 */
export function resolvePlanModeTools(requested: string[] | undefined): string[] {
    if (!requested) return [...PLAN_MODE_SUBAGENT_TOOLS];
    const filtered = requested.filter((t) => PLAN_MODE_ALLOWED.has(t));
    return filtered.length > 0 ? [...new Set(filtered)] : ["read"];
}

/** Error message returned to the child model when a bash command is refused. */
export function planModeBashBlockedMessage(command: string): string {
    return `Plan mode: command blocked (matches destructive pattern). This subagent is read-only — only non-mutating commands are allowed.\nCommand: ${command}`;
}

/**
 * Build a `bash` tool definition that refuses destructive commands before
 * executing anything. Registered under the name `bash` so it replaces the
 * built-in bash tool in the child session.
 */
export function createPlanModeBashTool(cwd: string): ToolDefinition {
    const base = createBashToolDefinition(cwd) as ToolDefinition;
    return {
        ...base,
        description: `${base.description}\n\nREAD-ONLY (plan mode): commands that modify files, processes, packages, or git state are rejected.`,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const command = String((params as { command?: unknown })?.command ?? "");
            // Always the full battery (sandboxActive = false): see module doc.
            if (isDestructiveCommand(command, false)) {
                throw new Error(planModeBashBlockedMessage(command));
            }
            return base.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    } as ToolDefinition;
}

/** Appended to the child's system prompt when running in plan mode. */
export const PLAN_MODE_SUBAGENT_PROMPT = `[PLAN MODE — READ-ONLY SUBAGENT]
You were launched from a session that is in plan mode, so you are restricted to read-only exploration.
- Available: read, grep, find, ls, and bash limited to non-mutating commands.
- Unavailable: edit, write, and any bash command that modifies files, processes, packages, or git state (these are rejected).
Investigate and report your findings; do not attempt to make changes.`;
