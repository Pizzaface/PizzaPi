#!/bin/bash
# "Are Your Lights On?" — PreToolUse:Bash
# Warns when the agent is about to run a git commit on the main/master branch
# without a feature branch. Does NOT block git operations on main — the
# block-dangerous-commands.sh hook handles hard blocks (force push, etc.).
# Exit 0 = allow (always).
set -euo pipefail

TOOL_INPUT=$(cat 2>/dev/null) || true
[[ -z "$TOOL_INPUT" ]] && exit 0

COMMAND=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true
[[ -z "$COMMAND" ]] && exit 0

# Only check git commit commands
if ! echo "$COMMAND" | grep -qE '(^|\s|&&|\|\||;|\|)\s*git\s+commit\s'; then
    exit 0
fi

# Get the current branch name
CURRENT_BRANCH=$(git -C "${PIZZAPI_PROJECT_DIR:-.}" symbolic-ref --short HEAD 2>/dev/null || true)

if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
    jq -n '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext: "⚠️  You are about to commit directly to the main/master branch. Per AGENTS.md, you should always create a feature branch first (git checkout -b feat/<name>). Are you sure this is intentional?"
        }
    }'
fi

exit 0
