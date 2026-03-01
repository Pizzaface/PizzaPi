#!/bin/bash
# "Are Your Lights On?" — PreToolUse:Edit/Write
# Hard-blocks edits to node_modules/. PizzaPi uses patches/ for upstream changes.
# Exit 2 = hard block. Exit 0 = allow.
set -euo pipefail

TOOL_INPUT=$(cat 2>/dev/null) || true
[[ -z "$TOOL_INPUT" ]] && exit 0

FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || true
[[ -z "$FILE_PATH" ]] && exit 0

# Block any edit to files inside node_modules
if echo "$FILE_PATH" | grep -qE '(^|/)node_modules/'; then
    echo "BLOCKED: Do not edit files inside node_modules/ directly. Changes to upstream packages go in patches/ and are applied via \`bun install\`. See AGENTS.md." >&2
    exit 2
fi

exit 0
