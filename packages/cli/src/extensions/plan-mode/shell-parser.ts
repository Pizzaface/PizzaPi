import { OUTPUT_REDIRECTION_PATTERN } from "./patterns.js";

/**
 * Split a shell command string on unquoted chaining operators (&&, ||, ;, |, &).
 * Respects single and double quotes so that patterns like `rg "foo|bar"` are
 * not incorrectly split on the `|` inside the quotes.
 * @internal Exported for testing only.
 */
export function splitShellSegments(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        // Handle backslash escapes: a backslash before a quote (or any char)
        // means the next character is literal and should not toggle quote state.
        if (ch === "\\" && i + 1 < command.length) {
            current += ch + command[i + 1];
            i++; // skip the escaped character
            continue;
        }

        // Toggle quote state on unescaped quotes.
        if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }

        // Inside quotes — accumulate without checking for operators
        if (inSingle || inDouble) { current += ch; continue; }

        // Check for multi-char operators first: && and ||
        if (i + 1 < command.length) {
            const two = ch + command[i + 1];
            if (two === "&&" || two === "||") {
                segments.push(current);
                current = "";
                i++; // skip second char
                continue;
            }
        }

        // Single-char operators: ; | &
        if (ch === ";" || ch === "|" || ch === "&") {
            segments.push(current);
            current = "";
            continue;
        }

        current += ch;
    }
    segments.push(current);
    return segments;
}

export function splitShellWords(command: string, keepQuotes = false): string[] {
    const words: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (const ch of command) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === "\\") {
            if (keepQuotes) current += ch;
            escaped = true;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            if (keepQuotes) current += ch;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            if (keepQuotes) current += ch;
            continue;
        }

        if (!inSingle && !inDouble && /\s/.test(ch)) {
            if (current) {
                words.push(current);
                current = "";
            }
            continue;
        }

        current += ch;
    }

    if (escaped) current += "\\";
    if (current) words.push(current);
    return words;
}

/**
 * Returns true if a raw (quote-preserving) token may be expanded by the shell.
 * Strips single-quoted segments (which bash never expands) before checking for
 * expansion characters in the remaining unquoted / double-quoted portions.
 * For unquoted tokens this behaves identically to checking the unquoted form.
 */
export function containsShellExpansion(token: string): boolean {
    // Remove single-quoted segments — bash never expands inside single quotes.
    const withoutSingleQuoted = token.replace(/'[^']*'/g, "");

    // For double-quoted segments: strip backslash escapes (\$, \`, \\) first,
    // then replace the quotes themselves. This preserves unescaped $VAR and
    // `cmd` inside double quotes (which bash DOES expand) while removing
    // safely-escaped content.
    const withoutDoubleQuoted = withoutSingleQuoted.replace(
        /"(?:[^"\\]|\\.)*"/g,
        (match) => match.slice(1, -1).replace(/\\([$`\\"])/g, ""),
    );

    // Remove backslash-escaped characters in unquoted text (e.g. \$VAR is literal).
    const stripped = withoutDoubleQuoted.replace(/\\./g, "");

    // Conservatively reject expansion characters in the remaining text:
    //  - variable / command substitution: $VAR, $(cmd)
    //  - backticks: `cmd`
    //  - pathname expansion (globbing): *, ?, [...]
    if (stripped.includes("$") || stripped.includes("`")) return true;
    if (stripped.includes("*") || stripped.includes("?") || stripped.includes("[") || stripped.includes("]")) return true;

    // Brace expansion: {a,b}, {1..3}
    // In bash, double-quoting prevents brace expansion, so we only check
    // truly unquoted text. Strip double-quoted segments entirely for this check.
    const unquotedOnly = withoutSingleQuoted.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\\./g, "");
    return /\{[^}]*,.*\}|\{[^}]*\.\.[^}]*\}/.test(unquotedOnly);
}

/**
 * In no-sandbox mode we block output redirection by default because it can
 * write to files. The only allowed exception is numeric fd redirection to
 * `/dev/null` (e.g. `2>/dev/null`), which is a common read-only pattern for
 * suppressing stderr.
 */
export function hasUnsafeOutputRedirection(segment: string): boolean {
    // Strip single-quoted segments before checking — content inside single
    // quotes is literal and cannot contain actual shell redirections.
    // e.g. `printf '>'` is NOT a redirection; `bash -c 'git status' > out` IS.
    let stripped = segment.replace(/'[^']*'/g, "''");
    // Strip double-quoted segments too — `>` inside double quotes is not a
    // shell redirection operator (e.g. `printf ">"` is safe).
    // Use escape-aware regex so `"he said \"hello\""` is handled correctly.
    stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');

    const matches = stripped.matchAll(OUTPUT_REDIRECTION_PATTERN);
    for (const match of matches) {
        const fd = match[2] ?? "";
        const target = (match[3] ?? "").replace(/^['"]|['"]$/g, "");
        const isSafeNullSink = fd.length > 0 && target === "/dev/null";
        if (!isSafeNullSink) return true;
    }
    return false;
}
