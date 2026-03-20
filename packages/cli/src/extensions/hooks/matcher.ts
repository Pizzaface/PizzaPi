// ---------------------------------------------------------------------------
// Tool name helpers
// ---------------------------------------------------------------------------

/** Map tool names from pi to hook-friendly display names. */
function toolDisplayName(toolName: string): string {
    switch (toolName) {
        case "bash":
            return "Bash";
        case "read":
            return "Read";
        case "write":
            return "Write";
        case "edit":
            return "Edit";
        case "grep":
            return "Grep";
        case "find":
            return "Find";
        case "ls":
            return "Ls";
        default:
            return toolName;
    }
}

/**
 * Split a matcher string on top-level `|` only — `|` inside parentheses is
 * left intact so regex groups like `mcp__(github|filesystem)__.*` survive.
 */
function splitTopLevelAlternation(matcher: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of matcher) {
        if (ch === "(") {
            depth++;
            current += ch;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
            current += ch;
        } else if (ch === "|" && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts.map((p) => p.trim());
}

/** Check if a tool name matches a hook matcher pattern (supports `|` alternation). */
export function matchesTool(matcher: string, toolName: string): boolean {
    const displayName = toolDisplayName(toolName);
    // Support | alternation: "Edit|Write" matches either.
    // Uses paren-aware splitting so grouped alternation like
    // `mcp__(github|filesystem)__.*` is preserved as a single regex.
    const patterns = splitTopLevelAlternation(matcher);
    for (const pattern of patterns) {
        if (pattern === ".*") return true;
        // Case-insensitive match against both raw name and display name
        if (pattern.toLowerCase() === toolName.toLowerCase()) return true;
        if (pattern.toLowerCase() === displayName.toLowerCase()) return true;
        // Regex match for complex patterns (e.g., mcp__.*)
        try {
            const re = new RegExp(`^${pattern}$`, "i");
            if (re.test(toolName) || re.test(displayName)) return true;
        } catch {
            // Invalid regex — fall through to literal comparison only
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Payload normalization — bridge pi tool input → hook script expectations
// ---------------------------------------------------------------------------

/**
 * Normalize tool input for hook scripts. Pi tools use `path` for file paths,
 * but the hook protocol (matching Claude Code) expects `file_path`. We include
 * both so scripts work regardless of which key they check.
 */
export function normalizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...input };
    // If the tool has `path` but not `file_path`, add the alias
    if ("path" in normalized && !("file_path" in normalized)) {
        normalized.file_path = normalized.path;
    }
    // Reverse alias too: if script sends file_path, also set path
    if ("file_path" in normalized && !("path" in normalized)) {
        normalized.path = normalized.file_path;
    }
    return normalized;
}
