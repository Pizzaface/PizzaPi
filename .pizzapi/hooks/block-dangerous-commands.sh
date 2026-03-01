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

# Force pushes to main/master (handles --force, -f, --force-with-lease)
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(--force|--force-with-lease|-f)\b'; then
    if echo "$COMMAND" | grep -qE '\s(main|master)\b|HEAD:main|HEAD:master'; then
        block_with_reason "Force push to main/master is forbidden. Use a feature branch."
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

# Prevent catastrophic recursive deletes (rm -rf, rm -fr, rm -r -f, etc.)
if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(/($|\s)|~|\$HOME|\.\.)'; then
    block_with_reason "Recursive delete of /, ~, or .. is forbidden."
fi

# Prevent deleting the entire .git directory
if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+.*\.git($|\s|/)'; then
    block_with_reason "Deleting .git is forbidden."
fi

exit 0
