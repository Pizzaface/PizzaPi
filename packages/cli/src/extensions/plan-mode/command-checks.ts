import { GIT_SAFE_SUBCOMMANDS, GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES } from "./patterns.js";
import { splitShellWords, containsShellExpansion } from "./shell-parser.js";

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * `git format-patch --stdout` prints patches to stdout without writing files.
 * Without `--stdout`, format-patch writes `.patch` files to the working directory.
 */
export function isSafeGitFormatPatchInvocation(segment: string): boolean {
    const words = splitShellWords(segment);
    if (words.length < 2) return false;
    if (words[0].toLowerCase() !== "git" || words[1].toLowerCase() !== "format-patch") return false;
    // Safe only when --stdout is present (no file output)
    return words.some((w) => w === "--stdout");
}

export function isSafeGitNotesInvocation(segment: string): boolean {
    const words = splitShellWords(segment);
    // Also parse with quotes preserved so we can check shell expansion
    // against the raw token — single-quoted values like '$literal' must
    // not false-positive on `containsShellExpansion`.
    const rawWords = splitShellWords(segment, true);
    if (words.length < 2) return false;
    if (words[0].toLowerCase() !== "git" || words[1].toLowerCase() !== "notes") return false;

    let index = 2;
    while (index < words.length) {
        const arg = words[index].toLowerCase();
        if (arg === "--ref") {
            if (index + 1 >= words.length) return false;
            // Check the raw (still-quoted) token for shell expansion so
            // that properly quoted refs like '$literal' pass through while
            // unquoted $VAR or *.glob are still rejected.
            const rawRefValue = rawWords[index + 1];
            if (containsShellExpansion(rawRefValue)) return false;
            index += 2;
            continue;
        }
        if (arg.startsWith("--ref=")) {
            // Check the raw token's value portion for shell expansion.
            const rawRefValue = rawWords[index].slice("--ref=".length);
            if (containsShellExpansion(rawRefValue)) return false;
            index++;
            continue;
        }
        break;
    }

    // bare `git notes` (with or without `--ref`) defaults to `git notes list`
    if (index >= words.length) return true;

    const subcommand = words[index].toLowerCase();
    // show, list — read-only
    // get-ref  — prints the effective notes ref, also read-only
    return subcommand === "show" || subcommand === "list" || subcommand === "get-ref";
}

export function isDestructiveGitCommand(segment: string): boolean {
    const gitMatch = segment.match(/^\s*git\s+(\S+)/i);
    if (!gitMatch) return false; // not a git command

    const subcommand = gitMatch[1].toLowerCase();

    // Subcommand not on the safe list → allow known read-only invocations, then destructive
    if (!GIT_SAFE_SUBCOMMANDS.has(subcommand)) {
        if (isSafeGitNotesInvocation(segment)) return false;
        if (isSafeGitFormatPatchInvocation(segment)) return false;
        return true;
    }

    // Subcommand is safe in general, but check for destructive argument patterns
    return GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES.some((p) => p.test(segment));
}

// ── Tar ──────────────────────────────────────────────────────────────────────

const TAR_LONG_MODE_PATTERN = /(^|\s)--(?:create|append|update|extract|get|delete|catenate|concatenate)\b/;
const TAR_BUNDLED_MODE_PATTERN = /^\s*tar\s+(-?[A-Za-z]+)\b/i;
const TAR_DESTRUCTIVE_SHORT_MODE_PATTERN = /[cruxA]/;
/**
 * Short tar options that accept an attached argument (e.g. `-fARCHIVE`).
 * When scanning option bundles for mode letters, anything after such a flag
 * is treated as payload (not more flags) to avoid false positives.
 */
const TAR_SHORT_OPTS_WITH_ATTACHED_ARG = new Set(["f", "g", "C", "X", "T", "I", "H"]);

/** Short tar mode flags that write to or update archives. */
const TAR_WRITE_MODE_PATTERN = /[cruA]/;

export function tarShortOptsForModeScan(shortOpts: string): string {
    let out = "";
    for (let i = 0; i < shortOpts.length; i++) {
        const ch = shortOpts[i];
        out += ch;
        if (TAR_SHORT_OPTS_WITH_ATTACHED_ARG.has(ch) && i < shortOpts.length - 1) break;
    }
    return out;
}

export function isDestructiveTarCommand(segment: string): boolean {
    if (!/^\s*tar\b/i.test(segment)) return false;

    // Check for --to-stdout / -O BEFORE the long-mode early return so that
    // `tar --extract --to-stdout` is correctly treated as read-only.
    const hasLongToStdout = /(?:^|\s)--to-stdout(?:\s|$)/i.test(segment);

    if (TAR_LONG_MODE_PATTERN.test(segment)) {
        // Long-form extract/get with --to-stdout is read-only (no files written).
        // Long-form write modes (--create, --append, --update, etc.) are always
        // destructive even with --to-stdout (they produce archive data).
        if (hasLongToStdout) {
            const hasLongWriteMode = /(?:^|\s)--(?:create|append|update|delete|catenate|concatenate)\b/.test(segment);
            if (!hasLongWriteMode) return false;
        }
        return true;
    }

    // Collect all short-option mode letters across the entire command so we can
    // reason about -O (stdout) and write-mode flags (-c/-r/-u/-A) together.
    let allModeLetters = "";

    // Check the first token for the traditional no-dash form: `tar czf archive.tar`
    const bundledMatch = segment.match(TAR_BUNDLED_MODE_PATTERN);
    if (bundledMatch) {
        allModeLetters += tarShortOptsForModeScan(bundledMatch[1].replace(/^-/, ""));
    }

    // Also scan all dash-prefixed option tokens to catch patterns where the mode
    // letter appears after other options, e.g. `tar -f archive.tar -x`.
    for (const match of segment.matchAll(/(?:^|\s)-([A-Za-z]+)/g)) {
        allModeLetters += tarShortOptsForModeScan(match[1]);
    }

    // Also check for long-form --to-stdout
    const hasStdout = /O/.test(allModeLetters) || hasLongToStdout;
    const hasWriteMode = TAR_WRITE_MODE_PATTERN.test(allModeLetters);

    // -O (stdout) only makes tar safe when no write-mode flag is present.
    // `tar -cO` still creates an archive (to stdout pipe) — that's a write operation.
    // `tar -xO` extracts to stdout — genuinely read-only.
    if (hasStdout && !hasWriteMode) return false;

    // Any destructive short mode letter present → destructive
    if (TAR_DESTRUCTIVE_SHORT_MODE_PATTERN.test(allModeLetters)) return true;

    return false;
}

// ── Gawk ─────────────────────────────────────────────────────────────────────

const GAWK_INCLUDE_ARG_PATTERN = /(?:^|\s)(?:-i(\S+)|-i\s+(\S+)|--include=(\S+)|--include\s+(\S+))/gi;
const GAWK_FILE_ARG_PATTERN = /(?:^|\s)(?:-f\s*(\S+)|--file=(\S+)|--file\s+(\S+))/g;
const GAWK_INPLACE_MODULE_PATTERN = /(?:^|[\\/])inplace(?:\.awk)?$/i;

export function isDestructiveGawkCommand(segment: string): boolean {
    // Check for both `gawk` and `awk` (which may be GNU Awk on some systems)
    if (!/^\s*(?:gawk|awk)\b/i.test(segment)) return false;

    for (const match of segment.matchAll(GAWK_INCLUDE_ARG_PATTERN)) {
        const includeArg = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").replace(/^['"]|['"]$/g, "");
        if (GAWK_INPLACE_MODULE_PATTERN.test(includeArg)) return true;
    }

    // Also flag `-f inplace.awk` / `--file=inplace.awk` because gawk ships an
    // inplace.awk library that rewrites files in-place, just like `-i inplace`.
    for (const match of segment.matchAll(GAWK_FILE_ARG_PATTERN)) {
        const fileArg = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^['"]|['"]$/g, "");
        if (GAWK_INPLACE_MODULE_PATTERN.test(fileArg)) return true;
    }

    return false;
}

// ── Patch ────────────────────────────────────────────────────────────────────

const PATCH_SAFE_LONG_FLAG_PATTERN = /(?:^|\s)--(?:dry-run|check|help|version)(?:\s|$)/i;

export function isDestructivePatchCommand(segment: string): boolean {
    if (!/^\s*patch\b/i.test(segment)) return false;

    // Check for output-writing flags first, which always make patch destructive
    // even if --dry-run is present, because `-o` / `--output` causes file writes.
    // Exception: `-o -`, `--output=-`, `--output -`, and `-o-` write to stdout (read-only preview), so allow those.
    const hasOutputFlag = /\s-o\s|\s-o\S|--output\b|--output=/i.test(segment);
    if (hasOutputFlag) {
        // Check for various forms of stdout output:
        // - `-o -` (space after -o)
        // - `--output=-` (equals with dash)
        // - `--output -` (space after --output)
        // - `-o-` (no space, no equals, dash immediately after -o)
        const isStdout = /\s-o\s-(?:\s|$)|-o-(?:\s|$)|--output=-(?:\s|$)|--output\s+-(?:\s|$)/i.test(segment);
        if (isStdout) {
            // Output to stdout is read-only — but still check for reject-file
            // writing below (don't return early).
        } else {
            // Output to a file is destructive
            return true;
        }
    }

    // Check for reject-file flags: `-r FILE` / `--reject-file=FILE`.
    // If a real file path is given (not `-` for stdout), patch writes rejected
    // hunks to disk — destructive even when main output goes to stdout.
    const hasRejectFile = /\s-r\s|\s-r\S|--reject-file\b|--reject-file=/i.test(segment);
    let rejectIsStdout = false;
    if (hasRejectFile) {
        rejectIsStdout = /\s-r\s-(?:\s|$)|-r-(?:\s|$)|--reject-file=-(?:\s|$)|--reject-file\s+-(?:\s|$)/i.test(segment);
        if (!rejectIsStdout) {
            return true; // reject file writes to a real path
        }
    }

    // If output goes to stdout (`-o -`), the command is only safe if the
    // reject file is ALSO directed to stdout (`-r -`). When `-r` is omitted
    // entirely, GNU patch names the reject file after the output file with
    // `.rej` appended — so `patch -o -` without `-r -` creates `-.rej` on disk.
    if (hasOutputFlag) {
        return !rejectIsStdout;
    }

    // `patch` is generally destructive, but a few explicit flags make it read-only.
    // - `--dry-run` / `--check` verify applicability without modifying files
    // - `--help` / `--version` are informational
    // - Verify each is a complete flag, not a prefix of another (e.g., not --version-control)
    if (PATCH_SAFE_LONG_FLAG_PATTERN.test(segment)) {
        // Verify the matched flags are actually safe (not part of compound flags)
        // --dry-run, --check, --help, --version must be standalone or followed by space/=
        const isDryRun = /(?:^|\s)--dry-run(?:\s|=|$)/.test(segment);
        const isCheck = /(?:^|\s)--check(?:\s|=|$)/.test(segment);
        const isHelp = /(?:^|\s)--help(?:\s|=|$)/.test(segment);
        const isVersion = /(?:^|\s)--version(?:\s|=|$)/.test(segment);

        if (isDryRun || isCheck || isHelp || isVersion) {
            return false;
        }
    }

    // Also check for short-flag `-C` standalone (the actual --check alias is `-C`)
    // But reject patterns like `-zC` where `-C` is not standalone
    if (/(?:^|\s)-C(?:\s|$)/.test(segment)) {
        return false;
    }

    return true;
}
