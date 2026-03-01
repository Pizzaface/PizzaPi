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

# Normalize quotes so quoted executables/args still match safety checks.
# Example: "/usr/bin/git" push --force origin "main"
UNQUOTED_COMMAND=$(echo "$COMMAND" | sed "s/['\"]//g")

block_with_reason() {
    echo "BLOCKED: $1" >&2
    exit 2
}

# Shell separators that terminate a token/command. Used throughout to prevent
# bypasses like `git push --force origin main; echo ok`.
_SEP='[[:space:];&|]'
_END="(${_SEP}|$)"

# Match git invocations (bare or absolute path). We allow any leading wrapper
# token (e.g. sudo/env/command) by matching on token boundaries.
_GIT_CMD_PREFIX='(^|[;&|[:space:]])(\/[^[:space:]]*\/)?git'
_GIT_PUSH_PATTERN="${_GIT_CMD_PREFIX}([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+push([[:space:]]|$)"
_GIT_COMMIT_OR_PUSH_PATTERN="${_GIT_CMD_PREFIX}([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+(commit|push)([[:space:]]|$)"

# Force pushes to main/master (handles --force, -f, --force-with-lease, and
# refspec-based force updates via leading '+' e.g. `git push origin +main`).
if echo "$UNQUOTED_COMMAND" | grep -qE "$_GIT_PUSH_PATTERN"; then
    IS_FORCE_PUSH=false
    IS_DELETE_PUSH=false

    # Explicit force flags
    if echo "$UNQUOTED_COMMAND" | grep -qE "(^|[[:space:]])(--force|--force-with-lease|-f)${_END}"; then
        IS_FORCE_PUSH=true
    fi

    # Refspec-based force update (`+<src>` or `+<src>:<dst>`)
    if echo "$UNQUOTED_COMMAND" | grep -qE '(^|[[:space:]])\+[^[:space:]]+'; then
        IS_FORCE_PUSH=true
    fi

    # Protected-branch delete forms:
    #   git push origin --delete main
    #   git push origin :main
    #   git push origin :refs/heads/main
    if echo "$UNQUOTED_COMMAND" | grep -qE "(^|[[:space:]])--delete${_END}" &&
       echo "$UNQUOTED_COMMAND" | grep -qE "(^|[[:space:]])(refs/heads/)?(main|master)${_END}"; then
        IS_DELETE_PUSH=true
    fi
    if echo "$UNQUOTED_COMMAND" | grep -qE "(^|[[:space:]])\+?:(refs/heads/)?(main|master)${_END}"; then
        IS_DELETE_PUSH=true
    fi

    if [[ "$IS_DELETE_PUSH" == true ]]; then
        block_with_reason "Deleting main/master via git push is forbidden. Use a feature branch workflow."
    fi

    if [[ "$IS_FORCE_PUSH" == true ]]; then
        # Catch common protected-branch ref forms (with or without leading '+'):
        #   main / master
        #   +main / +master
        #   HEAD:main / HEAD:master
        #   HEAD:refs/heads/main / HEAD:refs/heads/master
        #   refs/heads/main / refs/heads/master
        #   +refs/heads/main / +refs/heads/master
        if echo "$UNQUOTED_COMMAND" | grep -qE "HEAD:(refs/heads/)?(main|master)\b|(^|[[:space:]])\+?refs/heads/(main|master)\b|(^|[[:space:]:])\+?(main|master)${_END}"; then
            block_with_reason "Force push to main/master is forbidden. Use a feature branch."
        fi

        # Handle implicit refspec: `git push --force [origin]` without an
        # explicit branch/refspec pushes the current branch to its upstream.
        # When the current branch IS main/master this silently bypasses the
        # explicit-branch check above.
        #
        # Strategy: strip the `git ...push` prefix plus all option flags from
        # the command, leaving only positional args (<remote> [<refspec>...]).
        # If there are 0 or 1 positional args (i.e. no explicit refspec) and
        # the current branch is a protected branch, block the push.
        # Strip the git...push prefix, then remove option flags AND their
        # arguments for options that take a value (e.g. --push-option <val>,
        # -o <val>, --repo <val>, --receive-pack <val>).
        PUSH_TAIL=$(echo "$UNQUOTED_COMMAND" \
            | sed -E 's/.*[[:space:]]push[[:space:]]+//' \
            | sed -E 's/(^|[[:space:]])(--push-option|--receive-pack|--repo|-o)[[:space:]]+[^[:space:]-][^[:space:]]*//g' \
            | sed -E 's/(^|[[:space:]])-[^[:space:]]*//g' \
            | xargs)
        # Count remaining positional tokens (at most: remote + refspecs)
        POSITIONAL_COUNT=$(echo "$PUSH_TAIL" | wc -w | tr -d ' ')
        if [[ "$POSITIONAL_COUNT" -le 1 ]]; then
            # No explicit refspec — check the current branch
            CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
            if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
                block_with_reason "Force push to main/master is forbidden (current branch is $CURRENT_BRANCH). Use a feature branch."
            fi
        fi
    fi
fi

# Prevent skipping git hooks with --no-verify
if echo "$UNQUOTED_COMMAND" | grep -qE "$_GIT_COMMIT_OR_PUSH_PATTERN" &&
   echo "$UNQUOTED_COMMAND" | grep -qE "(^|[[:space:]])--no-verify${_END}"; then
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

# Regex that matches both bare `rm` and absolute-path variants like /bin/rm.
# We match against UNQUOTED_COMMAND so quoted executables are caught too.
_RM_PATTERN='(^|[;&|[:space:]])(\/[^[:space:]]*\/)?rm[[:space:]]'

_rm_parse_flags() {
    # Parse rm's flags from UNQUOTED_COMMAND, setting HAS_RECURSIVE / HAS_FORCE.
    HAS_RECURSIVE=false
    HAS_FORCE=false

    # Extract the portion after the first `rm` token (bare or absolute-path)
    local args
    args=$(echo "$UNQUOTED_COMMAND" | sed -n 's/.*[[:space:];&|][^[:space:]]*rm[[:space:]]\{1,\}\(.*\)/\1/p')
    [[ -z "$args" ]] && args=$(echo "$UNQUOTED_COMMAND" | sed -n 's/^[^[:space:]]*rm[[:space:]]\{1,\}\(.*\)/\1/p')
    [[ -z "$args" ]] && return

    # rm flags are expected before the first target path.
    local tokens
    read -r -a tokens <<< "$args"
    for token in "${tokens[@]}"; do
        case "$token" in
            --recursive) HAS_RECURSIVE=true ;;
            --force)     HAS_FORCE=true ;;
            --)          break ;;
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

if echo "$UNQUOTED_COMMAND" | grep -qE "$_RM_PATTERN"; then
    _rm_parse_flags
    if $HAS_RECURSIVE && $HAS_FORCE; then
        # Check for dangerous delete targets. This includes:
        #   /, /*, /.*
        #   ~, ~/*
        #   $HOME, $HOME/*
        #   parent-directory targets (.., ../, ../../, foo/..)
        if echo "$UNQUOTED_COMMAND" | grep -qE "${_SEP}/(${_END}|\*|\.\*)|${_SEP}~(${_END}|/\*)|${_SEP}\\\$HOME(${_END}|/\*)|(^|${_SEP})([^[:space:]]*/)?\.\.(/[^[:space:]]*)?${_END}"; then
            block_with_reason "Recursive delete of /, ~, or parent-directory paths (.., ../, ../../) is forbidden."
        fi
    fi
fi

# Prevent deleting the entire .git directory
if echo "$UNQUOTED_COMMAND" | grep -qE "$_RM_PATTERN"; then
    _rm_parse_flags
    if $HAS_RECURSIVE; then
        if echo "$UNQUOTED_COMMAND" | grep -qE "(^|[[:space:]])([^[:space:]]*/)?\.git(${_END}|/)"; then
            block_with_reason "Deleting .git is forbidden."
        fi
    fi
fi

exit 0
