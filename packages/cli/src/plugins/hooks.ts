/**
 * Hook event mapping — translates Claude Code hook events and tool matchers
 * into pi-coding-agent equivalents.
 */
import type { ClaudeHookEvent } from "./types.js";

// ── Hook event mapping ────────────────────────────────────────────────────────

/**
 * Maps Claude Code hook events to pi-coding-agent event names.
 *
 * Not all events have direct equivalents. Events that can't be mapped
 * are returned as null.
 */
export function mapHookEventToPi(claudeEvent: ClaudeHookEvent): string | null {
    const mapping: Record<ClaudeHookEvent, string | null> = {
        PreToolUse: "tool_call",
        PostToolUse: "tool_result",
        PostToolUseFailure: "tool_result",  // pi fires tool_result for both success/failure
        PermissionRequest: null,            // No pi equivalent
        UserPromptSubmit: "input",
        Notification: null,                 // No pi equivalent
        Stop: "agent_end",
        SubagentStart: null,                // No direct pi equivalent
        SubagentStop: null,                 // No direct pi equivalent
        SessionStart: "session_start",
        SessionEnd: "session_shutdown",
        TeammateIdle: null,                 // No pi equivalent
        TaskCompleted: null,                // No pi equivalent
        PreCompact: "session_before_compact",
        ConfigChange: null,                 // No pi equivalent
        WorktreeCreate: null,               // No pi equivalent
        WorktreeRemove: null,               // No pi equivalent
    };
    return mapping[claudeEvent] ?? null;
}

/**
 * Check if a tool name matches a Claude-style matcher pattern.
 *
 * Matchers use `|` for OR: "Edit|Write|MultiEdit"
 * Matchers can use `Bash(prefix:*)` for bash command prefix matching.
 */
export function matchesTool(matcher: string | undefined | unknown, toolName: string, toolInput?: Record<string, unknown>): boolean {
    if (matcher == null) return true; // No matcher = match all

    // Reject non-string matchers from malformed plugin configs — they
    // should NOT match any tool (previously returned true = match-all,
    // which could cause hooks to fire on every tool call by mistake).
    if (typeof matcher !== "string") return false;

    // Treat common wildcard patterns as match-all
    const trimmed = matcher.trim();
    if (trimmed === ".*" || trimmed === "*" || trimmed === ".+") return true;

    const patterns = matcher.split("|").map(s => s.trim());

    for (const pattern of patterns) {
        // Simple name match
        if (pattern === toolName) return true;

        // Map Claude tool names to pi tool names
        const claudeToPi: Record<string, string> = {
            Read: "read",
            Write: "write",
            Edit: "edit",
            Bash: "bash",
            Glob: "find",
            Grep: "grep",
            MultiEdit: "edit",
        };

        if (claudeToPi[pattern] === toolName) return true;

        // Bash(prefix:*) pattern matching
        const bashMatch = pattern.match(/^Bash\((.+):\*?\)$/);
        if (bashMatch && toolName === "bash" && toolInput) {
            const prefix = bashMatch[1];
            const command = (toolInput as any).command;
            if (typeof command === "string" && command.trimStart().startsWith(prefix)) {
                return true;
            }
        }
    }

    return false;
}
