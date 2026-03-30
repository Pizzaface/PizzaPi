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
 * If `segment` is a wrapper shell invocation that executes an inner command
 * string, returns the inner command string so it can be evaluated recursively.
 *
 * Returns:
 *  - `null`  — not a wrapper shell invocation (caller should analyse normally)
 *  - `""`    — IS a wrapper shell but inner command cannot be extracted
 *               (e.g. `bash -c` with no argument); callers should block conservatively
 *  - string  — the inner command/script text to evaluate for destructiveness
 *
 * Handles:
 *   - `bash -c 'CMD'`, `sh -lc 'CMD'`, `/usr/bin/bash -c 'CMD'`, etc.
 *     Inner command is the argument that follows the word containing `-c`.
 *   - `env [opts] [VAR=val...] COMMAND [args…]`
 *     Inner command is the reconstructed `COMMAND args` after skipping
 *     env's own flags and variable assignments.
 *
 * Note: `perl -e CODE` is intentionally NOT handled here — Perl code cannot
 * be re-evaluated as a shell command.  It is already caught by
 * DESTRUCTIVE_FLAG_PATTERNS and continues to be blocked unconditionally.
 */
function extractWrapperInnerCommand(segment: string): string | null {
    const words = splitShellWords(segment);
    if (words.length < 2) return null;

    // Strip any leading path component so /usr/bin/bash, /bin/sh, etc. are handled
    const first = words[0].toLowerCase().replace(/^.*[\/\\]/, "");

    // env as a command launcher: env [opts] [VAR=val...] COMMAND [args...]
    if (first === "env") {
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
            // Remaining tokens form the inner command + arguments
            return words.slice(i).join(" ");
        }
        // Only env options / variable assignments — env by itself prints the
        // environment and is harmless.  Return null so normal checks run.
        return null;
    }

    // Shell wrappers with -c flag (executes the next argument as shell code)
    if (WRAPPER_SHELLS.has(first)) {
        // --version / --help are safe queries; not a code-execution wrapper
        if (words.some((w) => w === "--version" || w === "--help")) return null;

        for (let i = 1; i < words.length; i++) {
            if (hasShortFlag(words[i], "c")) {
                // The command string is the next positional argument after -c.
                // If there is none (bare `bash -c`) return "" to block conservatively.
                return i + 1 < words.length ? words[i + 1] : "";
            }
        }
        return null; // no -c flag → not executing arbitrary code inline
    }

    return null;
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
                continue;
            }

            // Wrapper shells — extract the inner command and evaluate it
            // against the sandbox-active rules so that e.g.
            // `bash -c "curl -X POST ..."` and `bash -c "kill 1"` are caught
            // even when the OS sandbox is on (it only protects the filesystem,
            // not network mutations or process-control calls).
            const innerCmdSandbox = extractWrapperInnerCommand(trimmed);
            if (innerCmdSandbox !== null) {
                if (innerCmdSandbox === "" || isDestructiveCommand(innerCmdSandbox, true)) return true;
                continue; // inner command is safe; skip remaining checks
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

        // Wrapper shells/interpreters: bash -c, sh -c, env COMMAND, etc.
        // Instead of blanket-blocking all wrapper shells, extract the inner command
        // and evaluate it recursively.  This allows `env HOME=/tmp git status` and
        // `bash -lc "git status"` while still blocking `bash -c "rm -rf /"`.
        const innerCmd = extractWrapperInnerCommand(trimmed);
        if (innerCmd !== null) {
            // Also block if the outer wrapper itself has unsafe output redirection,
            // e.g. `bash -c 'git status' > output.txt` writes to a file.
            if (hasUnsafeOutputRedirection(trimmed)) return true;
            // Block if no extractable inner command, or if the inner command is destructive.
            if (innerCmd === "" || isDestructiveCommand(innerCmd, false)) return true;
            continue; // inner command is safe; skip remaining pattern checks
        }

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
