import { DESTRUCTIVE_CMD_PATTERNS, DESTRUCTIVE_FLAG_PATTERNS, SANDBOX_ONLY_CMD_PATTERNS, WRAPPER_SHELLS } from "./patterns.js";
import { splitShellSegments, splitShellWords, hasUnsafeOutputRedirection } from "./shell-parser.js";
import { isDestructiveGitCommand, isDestructiveTarCommand, isDestructiveGawkCommand, isDestructivePatchCommand } from "./command-checks.js";

// ── Wrapper shell/interpreter detection ──────────────────────────────────────────────────

/**
 * Returns true if `word` is a short-flag bundle containing the letter `flag`.
 * Handles both standalone (-c) and bundled (-xc) short flags.
 * Returns false for long flags (--flag).
 */
function hasShortFlag(word: string, flag: string): boolean {
    if (!word.startsWith("-") || word.startsWith("--")) return false;
    return word.slice(1).includes(flag);
}

/**
 * Returns true when `env` is being used as a command launcher, i.e. after
 * skipping env's own flags (like -i, -u VAR) and any VAR=val assignments,
 * there is at least one remaining argument that would be the wrapped command.
 *
 * `env` by itself (just prints environment) returns false.
 * `env FOO=bar rm file` returns true — rm is the wrapped command.
 */
function isEnvWithCommand(words: string[]): boolean {
    let i = 1; // skip "env"
    while (i < words.length) {
        const w = words[i];
        // Skip known env flags: -i/--ignore-environment, -0/--null, -v/--debug
        if (w === "-i" || w === "--ignore-environment" || w === "-0" || w === "--null" ||
            w === "-v" || w === "--debug" || w === "-") {
            i++;
            continue;
        }
        // Skip -u VAR / --unset VAR (separate argument forms)
        if ((w === "-u" || w === "--unset") && i + 1 < words.length) {
            i += 2;
            continue;
        }
        // Skip -u=VAR / --unset=VAR inline forms
        if (/^(?:-u|--unset)=/.test(w)) {
            i++;
            continue;
        }
        // Skip VAR=val environment variable assignments
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
            i++;
            continue;
        }
        // Any remaining token is a command argument — env is acting as a launcher
        return true;
    }
    return false;
}

/**
 * Detects wrapper shell and interpreter invocations that execute arbitrary code
 * via a -c flag, bypassing per-command analysis:
 *
 *   - `bash -c 'cmd'`, `sh -c 'cmd'`, `/usr/bin/bash -c 'cmd'`, etc.
 *   - `perl -e 'code'`, `perl -E 'code'`
 *   - `env [VAR=val...] COMMAND` (env used as a command launcher)
 *
 * These are only blocked in no-sandbox mode (the sandbox-active path handles
 * filesystem writes at the OS level and the check would be too restrictive there).
 *
 * Note: python/ruby/node with inline code flags are already caught by
 * DESTRUCTIVE_FLAG_PATTERNS and don't require a separate check here.
 */
function isWrapperShellCommand(segment: string): boolean {
    const words = splitShellWords(segment);
    if (words.length < 2) return false;

    // Strip any leading path component so /usr/bin/bash, /bin/sh, etc. are handled
    const first = words[0].toLowerCase().replace(/^.*[\/\\]/, "");

    // env as a command launcher: env [opts] [VAR=val...] COMMAND
    if (first === "env") {
        return isEnvWithCommand(words);
    }

    // Shell wrappers with -c flag (executes the next argument as shell code)
    if (WRAPPER_SHELLS.has(first)) {
        // Allow --version / --help queries
        if (words.some((w) => w === "--version" || w === "--help")) return false;
        return words.some((w) => hasShortFlag(w, "c"));
    }

    // perl -e / -E: inline Perl code execution
    // (belt-and-suspenders: also caught by DESTRUCTIVE_FLAG_PATTERNS for the common form)
    if (first === "perl") {
        if (words.some((w) => w === "--version" || w === "--help")) return false;
        return words.some((w) => hasShortFlag(w, "e") || hasShortFlag(w, "E"));
    }

    return false;
}

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

        // Wrapper shells/interpreters with -c/-e: bash -c, sh -c, perl -e, env COMMAND, etc.
        // These embed the real command in a string argument, bypassing per-token analysis.
        if (isWrapperShellCommand(trimmed)) return true;

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
