// ── Safe-command detection patterns ─────────────────────────────────────────

/**
 * DESTRUCTIVE_CMD_PATTERNS are checked against the first token (executable
 * name) of a command segment.  This avoids false positives when destructive
 * keywords appear as arguments, e.g. `grep "rm" src/`.
 */
export const DESTRUCTIVE_CMD_PATTERNS = [
    /^\s*rm\b/i, /^\s*rmdir\b/i, /^\s*mv\b/i, /^\s*cp\b/i, /^\s*mkdir\b/i, /^\s*touch\b/i,
    /^\s*chmod\b/i, /^\s*chown\b/i, /^\s*chgrp\b/i, /^\s*ln\b/i, /^\s*tee\b/i,
    /^\s*truncate\b/i, /^\s*dd\b/i, /^\s*shred\b/i,
    /^\s*sudo\b/i, /^\s*su\b/i,
    /^\s*kill\b/i, /^\s*pkill\b/i, /^\s*killall\b/i,
    /^\s*reboot\b/i, /^\s*shutdown\b/i,
    /^\s*(vim?|nano|emacs|code|subl)\b/i,
    /^\s*npm\s+(install|uninstall|update|ci|link|publish)/i,
    /^\s*yarn\s+(add|remove|install|publish)/i,
    /^\s*pnpm\s+(add|remove|install|publish)/i,
    /^\s*bun\s+(add|remove|install|link|publish)/i,
    /^\s*pip\s+(install|uninstall)/i,
    /^\s*apt(-get)?\s+(install|remove|purge|update|upgrade)/i,
    /^\s*brew\s+(install|uninstall|upgrade)/i,
    /^\s*systemctl\s+(start|stop|restart|enable|disable)/i,
    /^\s*service\s+\S+\s+(start|stop|restart)/i,
    // Filesystem-creating / file-modifying utilities missing from the original list
    /^\s*install\b/i,   // GNU install — always writes to destination
    /^\s*mkfifo\b/i,    // creates named pipes (filesystem objects)
    /^\s*mknod\b/i,     // creates device/special files
    // Note: `patch` is handled separately so `patch --dry-run` / `--check` stay allowed.
];

/**
 * Read-only git subcommands allowed in plan mode.
 *
 * Uses an **allowlist** instead of a blocklist because enumerating all
 * destructive git subcommands is fragile — new git versions add more, and
 * commands like `git clean`, `git apply`, `git restore`, `git am`, etc. are
 * easy to miss. Any `git <subcommand>` not on this list is treated as
 * destructive when the OS sandbox is unavailable.
 */
export const GIT_SAFE_SUBCOMMANDS = new Set([
    // Inspection / query
    "status", "log", "diff", "show", "blame", "grep", "shortlog",
    // Ref listing / lookup
    "branch", "tag", "remote", "stash",
    // Low-level read-only
    "ls-files", "ls-tree", "ls-remote", "cat-file", "rev-parse",
    "rev-list", "for-each-ref", "name-rev", "describe", "merge-base",
    "count-objects", "fsck", "verify-commit", "verify-tag", "verify-pack",
    // Diff plumbing (read-only)
    "diff-tree", "diff-files", "diff-index",
    // History / patch inspection (read-only, stdout-only)
    "archive", "cherry", "range-diff",
    // Notes (read-only subcommands; destructive overrides handle write ops)

    // Misc read-only
    "help", "version", "config", "reflog", "worktree",
]);

/**
 * Git subcommand + argument combinations that are destructive even though
 * the subcommand itself is on the safe list (e.g. `git branch -D`, `git
 * remote add`, `git stash drop`, `git config --unset`, `git worktree add`).
 */
export const GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES: RegExp[] = [
    // branch: -d/-D/-m/-M/-c/-C are mutating (must be a standalone short flag, not part of --merged etc.)
    /^\s*git\s+branch\s+.*\s-[dDmMcC]\b/i,
    /^\s*git\s+branch\s+-[dDmMcC]\b/i,
    // tag: -d (delete), -a/-s (create), or any arg that looks like a new tag name
    // We allow listing (no args, -l, --list, -n, --contains, --merged, etc.)
    /^\s*git\s+tag\s+.*-[dsafFu]/i,
    /^\s*git\s+tag\s+(?!-|$)\S/i, // `git tag v1.0` (creating a tag)
    // remote: add/remove/rm/rename/set-url/set-head/set-branches/prune/update
    /^\s*git\s+remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i,
    // stash: push/save/drop/pop/apply/clear are mutating; only list/show are safe
    /^\s*git\s+stash\s+(push|save|drop|pop|apply|clear|create|store)\b/i,
    /^\s*git\s+stash\s*$/i, // bare `git stash` is `git stash push`
    // config: writing operations
    /^\s*git\s+config\s+.*--(unset|unset-all|remove-section|rename-section|replace-all|add)\b/i,
    /^\s*git\s+config\s+(?!.*--(get|get-all|get-regexp|list|show-origin|show-scope|type|default|includes))\S+\s+\S/i,
    // reflog: delete/expire are mutating; show is safe
    /^\s*git\s+reflog\s+(delete|expire)\b/i,
    // worktree: add/remove/move/repair are mutating; list is safe
    /^\s*git\s+worktree\s+(add|remove|move|repair|lock|unlock)\b/i,
    // archive: -o / --output writes to a file instead of stdout
    /^\s*git\s+archive\b.*\s(-o\s|-o\S|--output\b|--output=)/i,
];

/**
 * Patterns that are dangerous regardless of filesystem sandbox.
 * These cause non-filesystem side effects (process control, privilege
 * escalation, system management) that the OS sandbox does NOT prevent.
 *
 * When the sandbox IS active, only these patterns are checked — the sandbox's
 * read-only overlay handles filesystem write protection at the OS level.
 */
export const SANDBOX_ONLY_CMD_PATTERNS = [
    // Process control & privilege escalation
    /^\s*sudo\b/i, /^\s*su\b/i,
    /^\s*kill\b/i, /^\s*pkill\b/i, /^\s*killall\b/i,
    /^\s*reboot\b/i, /^\s*shutdown\b/i,
    /^\s*systemctl\s+(start|stop|restart|enable|disable)/i,
    /^\s*service\s+\S+\s+(start|stop|restart)/i,
    // Remote / network side effects — sandbox only protects local filesystem
    // (Git commands are handled separately via the GIT_SAFE_SUBCOMMANDS allowlist)
    /^\s*npm\s+publish\b/i,
    /^\s*npx\b/i,
    /^\s*docker\s+push\b/i,
    /^\s*gh\s+(issue|pr|release)\s+(create|edit|close|merge|delete|comment)\b/i,
];

/**
 * DESTRUCTIVE_FLAG_PATTERNS are checked against the full command string.
 * These detect operators/flags that cause writes regardless of command name.
 */
export const DESTRUCTIVE_FLAG_PATTERNS = [
    />>/,
    /\bcurl\b.*\s(-o\S|-o\s|--output\b|--output=|-O\b|--remote-name\b|--remote-name-all\b|-D\s|-D\S|--dump-header\b|--dump-header=|-c\s|-c\S|--cookie-jar\b|--cookie-jar=|--trace\b|--trace=|--trace-ascii\b|--trace-ascii=|--libcurl\b|--libcurl=|--stderr\b|--stderr=|--hsts\b|--hsts=|--alt-svc\b|--alt-svc=)/i,
    /\bwget\b.*\s(-O\b|--output-document\b|--output-document=)/i,
    /\bfind\b.*\s-exec(dir)?\b/i, /\bfind\b.*\s-ok(dir)?\b/i, /\bfind\b.*\s-delete\b/i, /\bfind\b.*\s-fprintf\b/i,
    /\bgit\b.*\s--output[= ]/i,
    /\bsort\b.*\s(-o\s|-o\S|--output\b|--output=)/i,
    // In-place editing via sed/perl -i
    /\bsed\b.*\s-i\b/i, /\bsed\b.*\s-i\S/i,
    /\bperl\b.*\s-i\b/i, /\bperl\b.*\s-i\S/i,
    // Interpreters executing scripts (not just --version/--help)
    /^\s*python[23]?\s+(?!--(version|help)\b)\S/i,
    /^\s*ruby\s+(?!--(version|help)\b)\S/i,
    /^\s*node\s+(?!--(version|help)\b)\S/i,
    // Build tools (not --dry-run / --just-print / -n)
    /^\s*make\b(?!.*(\s-n\b|\s--dry-run\b|\s--just-print\b))/i,
];

/**
 * In no-sandbox mode we block output redirection by default because it can
 * write to files. The only allowed exception is numeric fd redirection to
 * `/dev/null` (e.g. `2>/dev/null`), which is a common read-only pattern for
 * suppressing stderr.
 */
export const OUTPUT_REDIRECTION_PATTERN = /(^|[^<])(\d*)>(?!>)(?:\s*([^\s;|&]+))?/g;

// ── Write-blocked tool names ─────────────────────────────────────────────────
// These tools are blocked when plan mode is active.
// Includes both core pi tools ("edit", "write") and PizzaPi custom tools ("write_file").
export const WRITE_BLOCKED_TOOL_NAMES = new Set(["edit", "write", "write_file"]);
