#!/bin/bash
# "Are Your Lights On?" — PostToolUse:Edit/Write
# After editing a source file, asks whether tests were added/updated.
# Skips test files, config files, docs, and non-code files.
# Always exits 0 (non-blocking).
set -euo pipefail

TOOL_INPUT=$(cat 2>/dev/null) || true
[[ -z "$TOOL_INPUT" ]] && exit 0

# jq is needed for output — if missing, skip silently (advisory hook)
if ! command -v jq &>/dev/null; then
    exit 0
fi

# Support both pi's "path" and Claude Code's "file_path" keys
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null) || true
[[ -z "$FILE_PATH" ]] && exit 0

FILENAME=$(basename "$FILE_PATH")
EXTENSION="${FILENAME##*.}"

# Only care about TypeScript/JavaScript source files (the PizzaPi stack)
case "$EXTENSION" in
    ts|tsx|js|jsx) ;;
    *) exit 0 ;; # Not a code file — skip
esac

# Skip test files — writing tests is the right thing
if echo "$FILENAME" | grep -qiE '\.test\.|\.spec\.|__test__|__spec__'; then
    exit 0
fi

# Skip config, build, and type declaration files
if echo "$FILENAME" | grep -qiE '\.config\.|\.d\.ts$|vite|tsconfig|tailwind|postcss'; then
    exit 0
fi

# Skip non-source directories (docs, scripts, config)
if echo "$FILE_PATH" | grep -qiE '/(docs|scripts|\.claude|\.pizzapi|\.github|docker|patches)/'; then
    exit 0
fi

# Skip index/barrel files (re-exports, not logic)
if echo "$FILENAME" | grep -qiE '^index\.(ts|js)$'; then
    exit 0
fi

# This is production source code. Ask the testing question.
jq -n '{
    hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Did you add or update a .test.ts file for this change? AGENTS.md requires all new code to include tests. Co-locate tests: foo.ts → foo.test.ts."
    }
}'

exit 0
