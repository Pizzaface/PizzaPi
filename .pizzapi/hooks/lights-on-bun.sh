#!/bin/bash
# "Are Your Lights On?" — PreToolUse:Bash
# PizzaPi uses Bun exclusively. Catches npm/yarn/pnpm/npx usage and asks
# the agent to reconsider. Does NOT block — some npx usage may be legitimate
# (e.g., npx playwright in MCP config), so we ask a question instead.
set -euo pipefail

TOOL_INPUT=$(cat 2>/dev/null) || true
[[ -z "$TOOL_INPUT" ]] && exit 0

COMMAND=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true
[[ -z "$COMMAND" ]] && exit 0

# Detect npm/yarn/pnpm as the primary command (not inside a string or comment)
# Match: starts with the command, or appears after && / || / ; / |
if echo "$COMMAND" | grep -qE '(^|\s|&&|\|\||;|\|)\s*(npm|yarn|pnpm|npx)\s'; then
    # Allow npx playwright — it's used in MCP config and is correct
    if echo "$COMMAND" | grep -qE 'npx\s+@?playwright'; then
        exit 0
    fi
    jq -n '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext: "This project uses Bun exclusively — not npm, yarn, or pnpm. Did you mean to use `bun`, `bunx`, or `bun run` instead? Check AGENTS.md if unsure."
        }
    }'
    exit 0
fi

# Detect Node being used where Bun should be
if echo "$COMMAND" | grep -qE '(^|\s|&&|\|\||;|\|)\s*node\s'; then
    jq -n '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext: "This project uses Bun as its runtime. Did you mean `bun` instead of `node`?"
        }
    }'
    exit 0
fi

exit 0
