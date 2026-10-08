// ── Plan-mode tool policy ────────────────────────────────────────────────────
//
// Plan mode is a read-only state, so tool access is an ALLOWLIST: a tool may
// run only when it is known to be read-only. Unknown tools — MCP tools without
// a `readOnlyHint: true` annotation, overlay/plugin tools, and any tool added
// later — are blocked until plan mode is exited.

import { WRITE_BLOCKED_TOOL_NAMES } from "./patterns.js";

/** Tool that toggles plan mode; always allowed so the agent can exit. */
export const TOGGLE_PLAN_MODE_TOOL = "toggle_plan_mode";

/**
 * Built-in / PizzaPi tools that only read state, ask the user something, or
 * update plan-mode's own planning UI. `bash` is listed here but every command
 * is still checked by `isDestructiveCommand` in the tool_call hook.
 *
 * `codemode` and the tool-search tools are allowed because they cannot reach
 * the host except through nested tool calls, which run through the same
 * tool_call hook (and therefore this policy) as direct calls.
 */
export const PLAN_MODE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    // pi built-ins
    "read", "grep", "find", "ls", "bash",
    // plan mode / user interaction
    TOGGLE_PLAN_MODE_TOOL, "plan_mode", "AskUserQuestion", "update_todo",
    // read-only PizzaPi tools
    "bash_output", "get_current_time", "list_models", "list_workflows", "list_tunnels",
    "list_available_triggers", "list_runner_triggers", "list_available_sigils", "get_session_id",
    "check_messages", "wait_for_message", "memory_read", "memory_list",
    "web_search", "web_fetch", "set_session_name",
    // tool discovery / sandboxed code mode (nested calls are re-checked)
    "search_tools", "tool_search", "codemode",
]);

/**
 * Effect metadata for dynamically registered tools (currently MCP tools),
 * keyed by registered tool name. `true` = annotated read-only.
 */
const dynamicToolReadOnly = new Map<string, boolean>();

/**
 * Record the trusted effect classification for a dynamically registered tool.
 * MCP registration calls this with `annotations.readOnlyHint === true`.
 */
export function setDynamicToolReadOnly(toolName: string, readOnly: boolean): void {
    dynamicToolReadOnly.set(toolName, readOnly);
}

/** @internal Test helper. */
export function clearDynamicToolEffects(): void {
    dynamicToolReadOnly.clear();
}

/**
 * Extra tool names a user explicitly trusts as read-only in plan mode, from
 * `PIZZAPI_PLAN_MODE_ALLOWED_TOOLS` (comma-separated). Hard-blocked write /
 * spawn tools cannot be re-enabled through it.
 */
function envAllowedTools(): Set<string> {
    const raw = process.env.PIZZAPI_PLAN_MODE_ALLOWED_TOOLS ?? "";
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Returns a block reason for `toolName` while plan mode is active, or null when
 * the tool may run (bash commands are checked separately by the caller).
 */
export function getPlanModeToolBlockReason(toolName: string): string | null {
    if (toolName === TOGGLE_PLAN_MODE_TOOL) return null;

    if (WRITE_BLOCKED_TOOL_NAMES.has(toolName)) {
        const isSpawnTool = toolName === "subagent" || toolName === "spawn_session";
        return isSpawnTool
            ? `Plan mode: "${toolName}" is blocked — spawning sessions creates child contexts with full write access, bypassing plan mode. Use toggle_plan_mode to exit plan mode first.`
            : `Plan mode: "${toolName}" is blocked in read-only mode. Use toggle_plan_mode to exit plan mode first.`;
    }

    // Dynamic (MCP) classification wins over the static list so an MCP tool
    // can never borrow a built-in read-only name.
    const dynamic = dynamicToolReadOnly.get(toolName);
    if (dynamic === true) return null;
    if (dynamic === false && !envAllowedTools().has(toolName)) {
        return `Plan mode: MCP tool "${toolName}" is blocked — it is not annotated read-only (readOnlyHint). Use toggle_plan_mode to exit plan mode first, or add it to PIZZAPI_PLAN_MODE_ALLOWED_TOOLS if you trust it to be read-only.`;
    }

    if (PLAN_MODE_READ_ONLY_TOOLS.has(toolName) || envAllowedTools().has(toolName)) return null;

    return `Plan mode: "${toolName}" is blocked — it is not known to be read-only. Use toggle_plan_mode to exit plan mode first, or add it to PIZZAPI_PLAN_MODE_ALLOWED_TOOLS if you trust it to be read-only.`;
}
