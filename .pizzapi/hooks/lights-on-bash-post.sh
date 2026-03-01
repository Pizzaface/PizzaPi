#!/bin/bash
# "Are Your Lights On?" — PostToolUse:Bash
# After a Bash command fails, asks three questions to break the retry loop.
# Skips test commands (failures are expected during TDD RED phase).
# Always exits 0 (non-blocking).
set -euo pipefail

TOOL_INPUT=$(cat 2>/dev/null) || true
[[ -z "$TOOL_INPUT" ]] && exit 0

COMMAND=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true
TOOL_RESPONSE=$(echo "$TOOL_INPUT" | jq -r '.tool_response // empty' 2>/dev/null) || true

# No response to check — skip
[[ -z "$TOOL_RESPONSE" ]] && exit 0

# Skip test commands — failures are expected during TDD RED phase
IS_TEST_CMD=false
if echo "$COMMAND" | grep -qE '(bun\s+test|bunx\s+jest|vitest)'; then
    IS_TEST_CMD=true
fi

if [[ "$IS_TEST_CMD" == "false" ]]; then
    # More specific checks first, then generic error fallback

    # Build command failed — remind about build order (most specific)
    if echo "$COMMAND" | grep -qE 'bun\s+run\s+build'; then
        if echo "$TOOL_RESPONSE" | grep -qiE 'error:|Cannot find module|could not resolve'; then
            jq -n '{
                hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    additionalContext: "Build failed. Did you respect the build order? tools must be built before server or cli. Run `bun run build` for the correct full sequence, or build individual packages in order: build:tools → build:server → build:ui → build:cli."
                }
            }'
            exit 0
        fi
    fi

    # Generic error pattern — ask three recovery questions
    if echo "$TOOL_RESPONSE" | grep -qiE 'error:|fatal:|command not found|no such file|permission denied|ENOENT|EACCES|panic:|traceback|ModuleNotFoundError|ImportError|Cannot find module|not found'; then
        jq -n '{
            hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: "The command appears to have failed. Before retrying the same approach: (1) Is there a dedicated tool (Read, Grep, Glob, Edit) that handles this better? (2) Did you read the error message carefully — does it tell you exactly what is wrong? (3) Is the approach itself wrong, not just the execution?"
            }
        }'
        exit 0
    fi
fi

exit 0
