// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of running a hook script. Mirrors the Claude Code hook JSON protocol:
 * - Exit 0 + JSON with additionalContext → inject context (soft nudge)
 * - Exit 2 + stderr → hard-block the tool call
 * - Exit 0 with no output → allow silently
 */
export interface HookResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /** True when the process was killed by a signal (e.g. timeout). */
    killed: boolean;
}

/** Parsed output from a hook that returned JSON on stdout. */
export interface HookOutput {
    /** Text to inject into the agent's context window. */
    additionalContext?: string;
    /** For PreToolUse: "allow" | "deny" | "ask". Default: "allow". */
    permissionDecision?: "allow" | "deny" | "ask";
    /** For PostToolUse: "block" to signal a problem. */
    decision?: "block";

    // -- Input hook fields --

    /** For Input hooks: transformed text to replace the original input. */
    text?: string;
    /** For Input hooks: "continue" | "transform" | "handled". */
    action?: "continue" | "transform" | "handled";

    // -- BeforeAgentStart hook fields --

    /** For BeforeAgentStart hooks: override the system prompt for this turn. */
    systemPrompt?: string;
}
