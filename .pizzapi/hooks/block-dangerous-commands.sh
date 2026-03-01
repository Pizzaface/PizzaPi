#!/bin/bash
# "Are Your Lights On?" — PreToolUse:Bash
# Hard-blocks irreversible operations: force push, --no-verify, dangerous rm.
# Exit 2 = hard block (stderr sent to agent as error message).
# Exit 0 = allow.
set -euo pipefail

# Safety: require jq — this is a blocking hook, fail-closed without it
if ! command -v jq &>/dev/null; then
    echo "BLOCKED: jq is required for safety hooks but not found in PATH." >&2
    exit 2
fi

TOOL_INPUT=$(cat 2>/dev/null) || true
[[ -z "$TOOL_INPUT" ]] && exit 0

COMMAND=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true
[[ -z "$COMMAND" ]] && exit 0

block_with_reason() {
    echo "BLOCKED: $1" >&2
    exit 2
}

# Force pushes to main/master (handles --force, -f, --force-with-lease, and
# refspec-based force updates via leading '+' e.g. `git push origin +main`).
if echo "$COMMAND" | grep -qE 'git\s+push\b'; then
    IS_FORCE_PUSH=false

    # Explicit force flags
    if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(--force|--force-with-lease|-f)\b'; then
        IS_FORCE_PUSH=true
    fi

    # Refspec-based force update (`+<src>` or `+<src>:<dst>`)
    if echo "$COMMAND" | grep -qE 'git\s+push\b.*(^|[[:space:]])\+[^[:space:]]+'; then
        IS_FORCE_PUSH=true
    fi

    if [[ "$IS_FORCE_PUSH" == true ]]; then
        # Catch common protected-branch ref forms (with or without leading '+'):
        #   main / master
        #   +main / +master
        #   HEAD:main / HEAD:master
        #   HEAD:refs/heads/main / HEAD:refs/heads/master
        #   refs/heads/main / refs/heads/master
        #   +refs/heads/main / +refs/heads/master
        if echo "$COMMAND" | grep -qE 'HEAD:(refs/heads/)?(main|master)\b|(^|[[:space:]])\+?refs/heads/(main|master)\b|(^|[[:space:]:])\+?(main|master)([[:space:]]|$)'; then
            block_with_reason "Force push to main/master is forbidden. Use a feature branch."
        fi
    fi
fi

# Prevent skipping git hooks with --no-verify
if echo "$COMMAND" | grep -qE 'git\s+(commit|push)\s+.*--no-verify'; then
    block_with_reason "Skipping git hooks (--no-verify) is not allowed. Fix the issue instead."
fi

# Prevent bypassing hooks via environment variables
if echo "$COMMAND" | grep -qE 'LEFTHOOK=0|HUSKY=0'; then
    block_with_reason "Bypassing git hooks via environment variables is not allowed."
fi

# ---------------------------------------------------------------------------
# Prevent catastrophic recursive deletes.
# Detects all flag forms: combined (-rf), split (-r -f), long (--recursive
# --force), and mixed (-r --force, --recursive -f), with optional extra flags.
# Also catches absolute-path rm invocations (/bin/rm, /usr/bin/rm, etc.)
# and quoted targets ("/" , '~', "$HOME").
# ---------------------------------------------------------------------------

# Regex that matches both bare `rm` and absolute-path variants like /bin/rm
_RM_PATTERN='(^|[;&|[:space:]])(\/[^ ]*\/)?rm[[:space:]]'

_rm_parse_flags() {
    # Parse rm's flags from $COMMAND, setting HAS_RECURSIVE / HAS_FORCE.
    HAS_RECURSIVE=false
    HAS_FORCE=false
    # Extract the portion after the first `rm` token (bare or absolute-path)
    local args
    args=$(echo "$COMMAND" | sed -n 's/.*[[:space:];&|][^ ]*rm[[:space:]]\{1,\}\(.*\)/\1/p')
    [[ -z "$args" ]] && args=$(echo "$COMMAND" | sed -n 's/^[^ ]*rm[[:space:]]\{1,\}\(.*\)/\1/p')
    [[ -z "$args" ]] && return
    for token in $args; do
        case "$token" in
            --recursive) HAS_RECURSIVE=true ;;
            --force)     HAS_FORCE=true ;;
            --*)         ;;  # other long options — skip
            -*)
                # Short option cluster: check for r and f individually
                [[ "$token" == *r* ]] && HAS_RECURSIVE=true
                [[ "$token" == *f* ]] && HAS_FORCE=true
                ;;
            *)  break ;;  # first non-flag token → stop scanning flags
        esac
    done
}

# Strip quotes from the command for target path matching so that
# `rm -rf "/"` and `rm -rf '~'` are caught.
UNQUOTED_COMMAND=$(echo "$COMMAND" | sed "s/['\"]//g")

if echo "$COMMAND" | grep -qE "$_RM_PATTERN"; then
    _rm_parse_flags
    if $HAS_RECURSIVE && $HAS_FORCE; then
        # Check if any target is a dangerous path (using quote-stripped version)
        if echo "$UNQUOTED_COMMAND" | grep -qE '[[:space:]]/([[:space:]]|$)|[[:space:]]~([[:space:]]|$)|[[:space:]]\$HOME([[:space:]]|$)|(^|[[:space:]])([^[:space:]]*/)?\.\.(/[^[:space:]]*)?([[:space:]]|$)'; then
            block_with_reason "Recursive delete of /, ~, or parent-directory paths (.., ../, ../../) is forbidden."
        fi
    fi
fi

# Prevent deleting the entire .git directory
if echo "$COMMAND" | grep -qE "$_RM_PATTERN"; then
    _rm_parse_flags
    if $HAS_RECURSIVE; then
        if echo "$UNQUOTED_COMMAND" | grep -qE '\.git($|[[:space:]]|/)'; then
            block_with_reason "Deleting .git is forbidden."
        fi
    fi
fi

exit 0
