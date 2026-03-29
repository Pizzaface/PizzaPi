import { DESTRUCTIVE_CMD_PATTERNS, DESTRUCTIVE_FLAG_PATTERNS, SANDBOX_ONLY_CMD_PATTERNS } from "./patterns.js";
import { splitShellSegments, hasUnsafeOutputRedirection } from "./shell-parser.js";
import { isDestructiveGitCommand, isDestructiveTarCommand, isDestructiveGawkCommand, isDestructivePatchCommand } from "./command-checks.js";

/**
 * Check if a command looks destructive based on known patterns.
 *
 * For most commands this is a **blocklist** check — known destructive patterns
 * are flagged and everything else passes. For `git` specifically an
 * **allowlist** approach is used because the set of mutating git subcommands
 * is too large to enumerate reliably (git clean, git apply, git restore,
 * git am, git bisect, etc.).
 *
 * When `sandboxActive` is true, only non-filesystem side effects are checked
 * (process control, privilege escalation, system management, remote mutations).
 * The OS-level sandbox enforces filesystem write restrictions, so output
 * redirection, script interpreters, and `find -exec` are all safe.
 * Command substitution is still rejected to prevent smuggling blocked commands.
 *
 * When `sandboxActive` is false (default), the full regex battery is applied
 * as the only line of defense against destructive commands.
 *
 * @internal Exported for testing only.
 */
export function isDestructiveCommand(command: string, sandboxActive = false): boolean {
    // ── Sandbox-active path: lightweight check ───────────────────────────
    // The OS sandbox enforces a read-only filesystem overlay. We only need
    // to block non-filesystem side effects that the sandbox doesn't cover.
    if (sandboxActive) {
        // Multi-line payloads and command/backtick/process substitution are
        // still rejected — they can smuggle commands past the per-segment
        // check regardless of sandbox state.
        if (/\$\(|`|\n|<\(|>\(/.test(command)) return true;

        const parts = splitShellSegments(command);
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;

            if (SANDBOX_ONLY_CMD_PATTERNS.some((p) => p.test(trimmed))) return true;

            // Git: reuse the same allowlist as the no-sandbox path. Any git
            // subcommand not on the safe list (send-pack, http-push, etc.)
            // is treated as destructive — this covers all plumbing commands
            // that can mutate remotes without enumerating them individually.
            // Note: we skip DESTRUCTIVE_FLAG_PATTERNS here because the
            // sandbox handles filesystem writes (redirection, -o, etc.).
            if (/^\s*git\b/i.test(trimmed)) {
                if (isDestructiveGitCommand(trimmed)) return true;
            }
        }
        return false;
    }

    // ── No-sandbox path: full regex battery ──────────────────────────────
    // Reject command substitution, backtick expansion, process substitution,
    // and multi-line payloads that could smuggle destructive commands past
    // the per-segment check.
    if (/\$\(|`|\n|<\(|>\(/.test(command)) return true;

    // Split on shell chaining operators, respecting quotes
    const parts = splitShellSegments(command);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue; // empty segment (e.g. trailing semicolon)

        // Git: allowlist-based check (stricter than the generic blocklist)
        if (/^\s*git\b/i.test(trimmed)) {
            if (isDestructiveGitCommand(trimmed)) return true;
            if (hasUnsafeOutputRedirection(trimmed)) return true;
            // Flag-level check still applies (e.g. git diff --output=...)
            if (DESTRUCTIVE_FLAG_PATTERNS.some((p) => p.test(trimmed))) return true;
            continue;
        }

        // tar, gawk, and patch need command-aware parsing to avoid false positives and
        // to account for read-only flags / legacy syntax.
        if (isDestructiveTarCommand(trimmed) || isDestructiveGawkCommand(trimmed) || isDestructivePatchCommand(trimmed)) return true;

        const isCmdDestructive = DESTRUCTIVE_CMD_PATTERNS.some((p) => p.test(trimmed));
        const hasUnsafeRedirection = hasUnsafeOutputRedirection(trimmed);
        const isFlagDestructive = DESTRUCTIVE_FLAG_PATTERNS.some((p) => p.test(trimmed));
        if (isCmdDestructive || hasUnsafeRedirection || isFlagDestructive) return true;
    }

    return false;
}

/**
 * @deprecated Use `isDestructiveCommand` instead. Kept for backward compat during transition.
 * @internal Exported for testing only.
 */
export function isSafeCommand(command: string): boolean {
    return !isDestructiveCommand(command);
}
