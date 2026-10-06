import {
    DESTRUCTIVE_CMD_PATTERNS,
    DESTRUCTIVE_FLAG_PATTERNS,
    SANDBOX_ONLY_CMD_PATTERNS,
    OPAQUE_INTERPRETER_PATTERNS,
    DANGEROUS_ENV_NAME_PATTERN,
    WRAPPER_SHELLS,
    PASSTHROUGH_WRAPPERS,
} from "./patterns.js";
import { splitShellSegments, splitShellWords, hasUnsafeOutputRedirection } from "./shell-parser.js";
import {
    isDestructiveGitCommand,
    isDestructiveTarCommand,
    isDestructiveGawkCommand,
    isDestructivePatchCommand,
    isDestructiveCurlCommand,
    isDestructiveGhCommand,
    isDestructiveClusterCommand,
    isDestructiveAwkProgram,
    isDestructiveSedScript,
    extractFindExecCommands,
} from "./command-checks.js";

// ── Segment normalization ────────────────────────────────────────────────────

const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
const LEADING_REDIRECTION_WORD = /^\d*(?:&>>?|>>?\|?|<<<?|<<-?|<>|>&|<&|<)/;
const PREFIX_KEYWORD = /^\s*(?:(?:if|then|else|elif|do|while|until)(?=\s)|[!({](?=\s|\S))\s*/;
/** Compound-command / definition keywords whose bodies we do not analyse. */
const OPAQUE_LEADING_KEYWORD = /^\s*(?:case|function|select|coproc)(?:\s|$)/;
/** `name() {` / `name () (` function definitions. */
const FUNCTION_DEFINITION = /^\s*[^\s()|&;<>]+\s*\(\s*\)/;
/** Builtins that only assign variables (`export X=1`). */
const ASSIGNMENT_BUILTINS = new Set(["export", "declare", "typeset", "readonly", "local"]);

/**
 * Returns true when an inline `NAME=value` assignment would change which code
 * a later command executes (PATH, LD_PRELOAD, GIT_*, *PAGER, …). `PAGER=cat`
 * style assignments that merely disable paging are allowed.
 *
 * @internal Exported for testing only.
 */
export function isDangerousEnvAssignment(word: string): boolean {
    const match = word.match(ASSIGNMENT_WORD);
    if (!match) return false;
    if (!DANGEROUS_ENV_NAME_PATTERN.test(match[1])) return false;
    const value = word.slice(word.indexOf("=") + 1).replace(/^['"]|['"]$/g, "");
    if (/PAGER$/i.test(match[1]) && (value === "" || value === "cat")) return false;
    return true;
}

/**
 * True if a raw (quote-preserving) command word contains an unquoted or
 * double-quoted expansion (`$VAR`, `${…}`, `$'…'`, backticks) or an unquoted
 * glob — i.e. the executable bash will run cannot be known statically.
 */
function isOpaqueCommandWord(rawWord: string): boolean {
    if (rawWord === "[" || rawWord === "[[") return false;
    const withoutSingle = rawWord.replace(/'[^']*'/g, "");
    if (/[$`]/.test(withoutSingle.replace(/\\./g, ""))) return true;
    const unquoted = withoutSingle.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\\./g, "");
    return /[*?[\]{}]/.test(unquoted);
}

/**
 * Canonicalise one shell segment for pattern matching:
 *   - strip leading grouping / control keywords (`(`, `{`, `!`, `if`, `then`,
 *     `do`, `while`, …) so `( rm x )` and `if x; then rm y; fi` are analysed;
 *   - strip leading variable assignments and redirections
 *     (`FOO=1 rm x`, `2>/dev/null rm x`), rejecting dangerous assignments;
 *   - unquote the command word and reduce it to its basename, so
 *     `/usr/bin/curl`, `\rm`, `'rm'` and `r""m` all match `^\s*name\b`.
 *
 * Returns the normalized segment (`""` for assignment-only / empty
 * segments), or `null` when the executed command cannot be determined
 * statically (expansion or glob in command position, function definitions,
 * `case`/`coproc`, dangerous env assignments) — callers treat `null` as
 * destructive.
 *
 * @internal Exported for testing only.
 */
export function normalizeSegment(segment: string): string | null {
    let rest = segment.trim();
    for (let guard = 0; guard < 64; guard++) {
        if (!rest) return "";
        if (OPAQUE_LEADING_KEYWORD.test(rest) || FUNCTION_DEFINITION.test(rest)) return null;

        const closer = rest.match(/^(?:\)\)?|\}|fi|done|esac)(?=\s|$|[)}])\s*/);
        if (closer) {
            rest = rest.slice(closer[0].length).trim();
            continue;
        }

        const keyword = rest.match(PREFIX_KEYWORD);
        if (keyword && keyword[0].length > 0) {
            rest = rest.slice(keyword[0].length).trim();
            continue;
        }

        const rawWords = splitShellWords(rest, true);
        const first = rawWords[0] ?? "";

        if (ASSIGNMENT_WORD.test(first)) {
            if (isDangerousEnvAssignment(splitShellWords(first)[0] ?? first)) return null;
            const off = findWordStartOffset(rest, 1);
            rest = off >= 0 ? rest.slice(off) : "";
            continue;
        }

        const redirect = first.match(LEADING_REDIRECTION_WORD);
        if (redirect) {
            // `>file cmd` (target attached) skips one word; `> file cmd` two.
            const skip = redirect[0].length === first.length ? 2 : 1;
            const off = findWordStartOffset(rest, skip);
            rest = off >= 0 ? rest.slice(off) : "";
            continue;
        }

        if (isOpaqueCommandWord(first)) return null;

        const unquoted = splitShellWords(first)[0] ?? "";
        const base = unquoted.replace(/^.*[/\\]/, "") || unquoted;

        if (ASSIGNMENT_BUILTINS.has(base.toLowerCase())) {
            const words = splitShellWords(rest);
            if (words.slice(1).some(isDangerousEnvAssignment)) return null;
        }

        const restOff = findWordStartOffset(rest, 1);
        return restOff >= 0 ? `${base} ${rest.slice(restOff)}` : base;
    }
    return null;
}

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
    const first = words[0].toLowerCase().replace(/^.*[/\\]/, "");

    // ── Bare inline environment-variable assignments (VAR=val ... CMD args) ──────
    // e.g. `HOME=/tmp rm -rf /` — treat exactly like `env HOME=/tmp rm -rf /`.
    // This pattern appears in inner commands extracted from `bash -c '...'` strings
    // and would otherwise bypass destructive-command detection because the first
    // token starts with an identifier, not a recognised command name.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        let i = 0;
        while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
            if (isDangerousEnvAssignment(words[i])) return "";
            i++;
        }
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

    // ── Passthrough wrappers (time, nohup, timeout, nice, stdbuf, etc.) ─────────────────
    // These commands don't interpret code — they simply exec their argument list
    // as-is (possibly after consuming some leading flags / a numeric argument).
    // `time git push`, `nohup rm -rf /`, `timeout 5 git push`, etc. must all be
    // unwrapped so the inner command can be checked for destructiveness.
    if (PASSTHROUGH_WRAPPERS.has(first)) {
        let i = 1;
        // Skip flags and, when a flag takes a required numeric argument
        // (e.g. `nice -n 5`, `timeout -k 5s`), skip that argument too.
        while (i < words.length && words[i].startsWith("-")) {
            i++;
            // Numeric/duration value immediately following a flag — skip it.
            if (i < words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[i])) {
                i++;
            }
        }
        // `timeout DURATION COMMAND` — the first positional arg is always the
        // duration (a plain number or number+suffix like "5s"), not a command.
        if (first === "timeout" && i < words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[i])) {
            i++;
        }
        if (i >= words.length) return null; // wrapper only, no inner command
        const paOff = findWordStartOffset(segment, i);
        return paOff >= 0 ? segment.slice(paOff) : "";
    }

    // xargs [opts] CMD [args…] — runs CMD with arguments read from stdin
    // (`… | xargs kill`, `… | xargs rm`). Without CMD it runs `echo`.
    if (first === "xargs") {
        const XARGS_ARG_FLAGS = new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--eof", "--replace", "--process-slot-var"]);
        let i = 1;
        while (i < words.length && words[i].startsWith("-")) {
            if (words[i] === "--") { i++; break; }
            if (XARGS_ARG_FLAGS.has(words[i])) i++;
            i++;
        }
        if (i >= words.length) return null;
        const off = findWordStartOffset(segment, i);
        return off >= 0 ? segment.slice(off) : "";
    }

    // watch [opts] CMD… — runs CMD (via `sh -c`) repeatedly.
    if (first === "watch") {
        const WATCH_ARG_FLAGS = new Set(["-n", "--interval", "-q", "--equexit"]);
        let i = 1;
        while (i < words.length && words[i].startsWith("-")) {
            if (words[i] === "--") { i++; break; }
            if (WATCH_ARG_FLAGS.has(words[i])) i++;
            i++;
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
            if (w.startsWith("--split-string=")) {
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
            if (w.startsWith("--chdir=")) {
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
                // PATH / LD_PRELOAD / GIT_* etc. change what the inner command runs.
                if (isDangerousEnvAssignment(w)) return "";
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
    const first = words[0].toLowerCase().replace(/^.*[/\\]/, "");
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
 * Non-filesystem side effects: process control, privilege escalation, system
 * management, network/remote mutations, and opaque code execution. The OS
 * read-only overlay does not stop any of these, so they are checked in both
 * sandbox and no-sandbox mode. `segment` must already be normalized.
 */
function hasNonFilesystemSideEffect(segment: string): boolean {
    if (SANDBOX_ONLY_CMD_PATTERNS.some((p) => p.test(segment))) return true;
    if (OPAQUE_INTERPRETER_PATTERNS.some((p) => p.test(segment))) return true;
    if (isDestructiveCurlCommand(segment)) return true;
    if (isDestructiveGhCommand(segment)) return true;
    if (isDestructiveClusterCommand(segment)) return true;
    if (isDestructiveAwkProgram(segment)) return true;
    if (isDestructiveSedScript(segment)) return true;
    // `bash script.sh` executes a file whose contents cannot be inspected.
    if (isWrapperShellFileExecution(segment)) return true;
    return false;
}

/**
 * Check if a command looks destructive based on known patterns.
 *
 * For most commands this is a **blocklist** check — known destructive patterns
 * are flagged and everything else passes. For `git`, `gh`, `docker`/`podman`,
 * `kubectl` and `helm` an **allowlist** of read-only subcommands is used
 * instead. Command words are normalized first (basename, unquoted, leading
 * keywords/assignments/redirections stripped), and any segment whose
 * executable cannot be determined statically is treated as destructive.
 *
 * When `sandboxActive` is true, filesystem writes (redirection, `rm`,
 * `sed -i`, …) are left to the OS-level read-only overlay, but every
 * non-filesystem side effect — process control, privilege escalation,
 * network/remote mutations, interpreters and other opaque code execution —
 * is still blocked, because the overlay does not prevent those.
 *
 * When `sandboxActive` is false (default), the full regex battery is applied
 * as the only line of defense against destructive commands.
 *
 * @internal Exported for testing only.
 */
export function isDestructiveCommand(command: string, sandboxActive = false): boolean {
    // Reject command substitution, backtick expansion, process substitution,
    // and multi-line payloads that could smuggle destructive commands past
    // the per-segment check — regardless of sandbox state.
    if (/\$\(|`|\n|\r|<\(|>\(/.test(command)) return true;
    // Bash network pseudo-devices open sockets via plain redirection.
    if (/\/dev\/(?:tcp|udp)\//i.test(command)) return true;

    // Split on shell chaining operators, respecting quotes
    const parts = splitShellSegments(command);

    for (const part of parts) {
        const original = part.trim();
        if (!original) continue; // empty segment (e.g. trailing semicolon)

        const trimmed = normalizeSegment(original);
        if (trimmed === null) return true; // executable cannot be determined
        if (!trimmed) {
            // Assignment- or redirection-only segment (`X=1`, `> file`).
            if (!sandboxActive && hasUnsafeOutputRedirection(original)) return true;
            continue;
        }

        if (hasNonFilesystemSideEffect(trimmed)) return true;

        // Git: allowlist-based check (stricter than the generic blocklist).
        // Any subcommand not on the safe list (push, send-pack, http-push, …)
        // is destructive in both modes.
        if (/^\s*git\b/i.test(trimmed)) {
            if (isDestructiveGitCommand(trimmed)) return true;
            if (sandboxActive) continue;
            if (hasUnsafeOutputRedirection(original)) return true;
            // Flag-level check still applies (e.g. git diff --output=...)
            if (DESTRUCTIVE_FLAG_PATTERNS.some((p) => p.test(trimmed))) return true;
            continue;
        }

        // Wrapper shells/launchers: bash -c, env COMMAND, xargs, timeout, …
        // Extract the inner command and evaluate it recursively. This allows
        // `env HOME=/tmp git status` and `bash -lc "git status"` while still
        // blocking `bash -c "rm -rf /"` and `… | xargs kill`.
        const innerCmd = extractWrapperInnerCommand(trimmed);
        if (innerCmd !== null) {
            // Also block if the outer wrapper itself has unsafe output redirection,
            // e.g. `bash -c 'git status' > output.txt` writes to a file.
            if (!sandboxActive && hasUnsafeOutputRedirection(original)) return true;
            // Block if no extractable inner command, or if the inner command is destructive.
            if (innerCmd === "" || isDestructiveCommand(innerCmd, sandboxActive)) return true;
            continue; // inner command is safe; skip remaining pattern checks
        }

        if (sandboxActive) {
            // find -exec runs an arbitrary command; check it like any other.
            const execCommands = extractFindExecCommands(trimmed);
            if (execCommands?.some((c) => !c || isDestructiveCommand(c, true))) return true;
            continue;
        }

        // ── No-sandbox: filesystem writes must be caught here ────────────
        // tar, gawk, and patch need command-aware parsing to avoid false positives and
        // to account for read-only flags / legacy syntax.
        if (isDestructiveTarCommand(trimmed) || isDestructiveGawkCommand(trimmed) || isDestructivePatchCommand(trimmed)) return true;

        const isCmdDestructive = DESTRUCTIVE_CMD_PATTERNS.some((p) => p.test(trimmed));
        const hasUnsafeRedirection = hasUnsafeOutputRedirection(original);
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
