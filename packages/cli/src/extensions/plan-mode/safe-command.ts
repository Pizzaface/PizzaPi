import { DESTRUCTIVE_CMD_PATTERNS, DESTRUCTIVE_FLAG_PATTERNS, SANDBOX_ONLY_CMD_PATTERNS, WRAPPER_SHELLS } from "./patterns.js";
import { splitShellSegments, splitShellWords, hasUnsafeOutputRedirection } from "./shell-parser.js";
import { isDestructiveGitCommand, isDestructiveTarCommand, isDestructiveGawkCommand, isDestructivePatchCommand } from "./command-checks.js";

// ── Wrapper shell/interpreter detection ──────────────────────────────────────────────────

/**
 * Returns the byte offset in `str` where the word at `wordIndex` (0-based)
 * begins, using the same whitespace/quote-based tokenization as
 * `splitShellWords`.  Returns -1 when `wordIndex` is out of range.
 *
 * Preserving the original slice (rather than re-joining words) ensures that
 * quoting is intact when the extracted substring is later evaluated for
 * destructiveness — e.g. `printf '>'` must not be confused with an output
 * redirection.
 */
function findWordStartOffset(str: string, wordIndex: number): number {
    let pos = 0;
    let count = 0;
    while (pos < str.length) {
        // Skip inter-word whitespace
        while (pos < str.length && /\s/.test(str[pos])) pos++;
        if (pos >= str.length) break;
        // Found the start of a word — return if it is the target
        if (count === wordIndex) return pos;
        // Skip past this word, respecting single/double quotes
        let inSingle = false;
        let inDouble = false;
        while (pos < str.length) {
            const ch = str[pos];
            if (ch === "\\" && !inSingle && pos + 1 < str.length) { pos += 2; continue; }
            if (ch === "'" && !inDouble) { inSingle = !inSingle; pos++; continue; }
            if (ch === '"' && !inSingle) { inDouble = !inDouble; pos++; continue; }
            if (!inSingle && !inDouble && /\s/.test(ch)) break;
            pos++;
        }
        count++;
    }
    return -1;
}

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

    // ── Bare inline environment-variable assignments (VAR=val ... CMD args) ──────
    // e.g. `HOME=/tmp rm -rf /` — treat exactly like `env HOME=/tmp rm -rf /`.
    // This pattern appears in inner commands extracted from `bash -c '...'` strings
    // and would otherwise bypass destructive-command detection because the first
    // token starts with an identifier, not a recognised command name.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        let i = 0;
        while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
        if (i >= words.length) return null; // only assignments, no actual command
        const off = findWordStartOffset(segment, i);
        return off >= 0 ? segment.slice(off) : "";
    }

    // ── Pass-through shell builtins ───────────────────────────────────────────
    // `command CMD`, `builtin CMD`, and `exec CMD` all ultimately invoke CMD;
    // strip the prefix and check the actual command for destructiveness.

    if (first === "command") {
        let i = 1;
        // `command -v CMD` / `command -V CMD` are lookup-only — not execution.
        if (i < words.length && (words[i] === "-v" || words[i] === "-V")) return null;
        // Skip other option flags (-p, etc.) up to an optional `--` terminator.
        while (i < words.length && words[i] !== "--" && words[i].startsWith("-")) i++;
        if (i < words.length && words[i] === "--") i++;
        if (i >= words.length) return null;
        const off = findWordStartOffset(segment, i);
        return off >= 0 ? segment.slice(off) : "";
    }

    if (first === "builtin") {
        // `builtin CMD args` — bypasses shell functions but still runs CMD.
        if (words.length < 2) return null;
        const off = findWordStartOffset(segment, 1);
        return off >= 0 ? segment.slice(off) : "";
    }

    if (first === "exec") {
        // `exec CMD` replaces the current process with CMD.
        // Recognised flags: -a name (argv[0]), -c (clean env), -l (login).
        let i = 1;
        while (i < words.length) {
            if (words[i] === "--") { i++; break; }
            if (words[i] === "-a" && i + 1 < words.length) { i += 2; continue; }
            if (words[i].startsWith("-")) { i++; continue; }
            break;
        }
        if (i >= words.length) return null;
        const off = findWordStartOffset(segment, i);
        return off >= 0 ? segment.slice(off) : "";
    }

    // env as a command launcher: env [opts] [VAR=val...] COMMAND [args...]
    if (first === "env") {
        let i = 1; // skip "env"
        while (i < words.length) {
            const w = words[i];

            // `--` terminates option parsing; everything after is the command.
            if (w === "--") {
                if (i + 1 >= words.length) return null; // `env --` with no command
                const off = findWordStartOffset(segment, i + 1);
                return off >= 0 ? segment.slice(off) : "";
            }

            // -S / --split-string: the argument IS the inner command string.
            // GNU env splits the string into tokens and runs it as a command;
            // we return the string directly so it can be evaluated.
            if (w === "-S" || w === "--split-string") {
                return i + 1 < words.length ? words[i + 1] : "";
            }
            if (/^--split-string=/.test(w)) {
                return w.slice("--split-string=".length);
            }

            // Known no-arg flags
            if (w === "-i" || w === "--ignore-environment" ||
                w === "-0" || w === "--null" ||
                w === "-v" || w === "--debug" ||
                w === "-") {
                i++;
                continue;
            }

            // -u VAR / --unset VAR (takes one argument)
            if ((w === "-u" || w === "--unset") && i + 1 < words.length) {
                i += 2;
                continue;
            }
            // -u=VAR / --unset=VAR inline forms
            if (/^(?:-u|--unset)=/.test(w)) {
                i++;
                continue;
            }

            // -C DIR / --chdir DIR (takes one argument)
            if ((w === "-C" || w === "--chdir") && i + 1 < words.length) {
                i += 2;
                continue;
            }
            // --chdir=DIR inline form
            if (/^--chdir=/.test(w)) {
                i++;
                continue;
            }

            // Short flag bundles (e.g. -iv, -iC /tmp, -iS 'cmd').
            // Only applies to bundles of length > 2 (e.g. "-iC", not "-C").
            if (w.startsWith("-") && !w.startsWith("--") && w.length > 2) {
                const flags = w.slice(1);
                if (flags.includes("S")) {
                    // -…S… in bundle: next word is the inner command string
                    return i + 1 < words.length ? words[i + 1] : "";
                }
                if (flags.includes("C") || flags.includes("u")) {
                    // Arg-taking flag in bundle — consume bundle + next word
                    i += 2;
                    continue;
                }
                // No-arg bundle (e.g. -iv, -i0)
                i++;
                continue;
            }

            // VAR=val environment variable assignments
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
                i++;
                continue;
            }

            // First non-flag, non-assignment word is the inner command.
            // Slice the ORIGINAL segment string (not words.slice(i).join(" "))
            // so that quoting is preserved for downstream checks.
            const off = findWordStartOffset(segment, i);
            return off >= 0 ? segment.slice(off) : "";
        }
        // Only env options / variable assignments — env by itself prints the
        // environment and is harmless.  Return null so normal checks run.
        return null;
    }

    // Shell wrappers with -c flag (executes the next argument as shell code)
    if (WRAPPER_SHELLS.has(first)) {
        // Locate the -c flag first so we know whether inline code execution is happening.
        let cFlagIdx = -1;
        for (let i = 1; i < words.length; i++) {
            if (hasShortFlag(words[i], "c")) { cFlagIdx = i; break; }
        }

        // --help / --version short-circuit ONLY when there is no -c flag.
        // `bash -c 'rm -rf /' --help` still has a -c; its inner command must be
        // inspected — the trailing --help does NOT make it safe.
        if (cFlagIdx === -1 && words.some((w) => w === "--version" || w === "--help")) return null;

        if (cFlagIdx >= 0) {
            // The command string is the next positional argument after -c.
            // If there is none (bare `bash -c`) return "" to block conservatively.
            return cFlagIdx + 1 < words.length ? words[cFlagIdx + 1] : "";
        }
        return null; // no -c flag → not executing arbitrary code inline
    }

    return null;
}

/**
 * Returns true when `segment` is a wrapper-shell invocation that executes a
 * file (e.g. `bash script.sh`, `sh ./run.sh`) rather than using `-c` or
 * `--help` / `--version`.
 *
 * In no-sandbox mode we cannot inspect the file's contents, so any such
 * invocation is treated as potentially destructive.  In sandbox mode the
 * filesystem overlay provides protection, so this check is skipped.
 *
 * @internal Exported for testing only.
 */
export function isWrapperShellFileExecution(segment: string): boolean {
    const words = splitShellWords(segment);
    if (words.length < 2) return false;
    const first = words[0].toLowerCase().replace(/^.*[\/\\]/, "");
    if (!WRAPPER_SHELLS.has(first)) return false;

    // If -c is present, extractWrapperInnerCommand handles it — not our concern.
    for (let i = 1; i < words.length; i++) {
        if (hasShortFlag(words[i], "c")) return false;
    }

    // --help / --version with no -c — safe informational queries.
    if (words.slice(1).some((w) => w === "--help" || w === "--version")) return false;

    // Any non-flag positional argument is treated as a filename to execute.
    const positionalArgs = words.slice(1).filter((w) => !w.startsWith("-"));
    return positionalArgs.length > 0;
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

        // P1-3: `bash script.sh` / `sh run.sh` (no -c flag) executes an
        // arbitrary file whose contents cannot be inspected at static-analysis
        // time.  In no-sandbox mode treat this as destructive.  In sandbox mode
        // the filesystem overlay limits the damage, so we allow it (the check
        // is only reached on the no-sandbox code path).
        if (isWrapperShellFileExecution(trimmed)) return true;

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
