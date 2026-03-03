import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

/** Maximum chars of stderr to retain in memory. */
const MAX_STDERR_CHARS = 512;

/**
 * Maximum chars to buffer in the partial (incomplete) line accumulator.
 * Prevents OOM when a subprocess emits very long lines without newlines
 * (e.g. minified files, binary output). When exceeded, the partial is
 * flushed as a complete line and counting continues.
 */
const MAX_PARTIAL_CHARS = 256 * 1024; // 256 KB

interface SpawnResult {
    lines: string[];
    exitCode: number | null;
    signal: string | null;
    /** True when the child was killed because it hit the line cap. */
    truncated: boolean;
    error?: string;
}

/**
 * Spawn a command with an argument array (no shell) and stream stdout,
 * collecting at most `maxLines` lines before killing the child process.
 * This is the shell-free equivalent of `cmd args | head -N`.
 */
function spawnHeadLines(
    cmd: string,
    args: string[],
    maxLines: number,
    timeoutMs: number,
): Promise<SpawnResult> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: timeoutMs,
        });

        const collected: string[] = [];
        let partial = "";
        let done = false;
        let stderr = "";

        // StringDecoder buffers incomplete multi-byte UTF-8 sequences across
        // chunk boundaries, preventing corruption of non-ASCII characters
        // (accented, CJK, emoji, etc.) that may span two data events.
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");

        child.stderr!.on("data", (chunk: Buffer) => {
            if (stderr.length < MAX_STDERR_CHARS) {
                stderr += stderrDecoder.write(chunk);
                if (stderr.length > MAX_STDERR_CHARS) {
                    stderr = stderr.slice(0, MAX_STDERR_CHARS);
                }
            }
        });

        child.stdout.on("data", (chunk: Buffer) => {
            if (done) return;

            partial += stdoutDecoder.write(chunk);

            // Guard against unbounded memory from very long lines (e.g.
            // minified JS, binary output). Flush partial as a line if it
            // exceeds the cap, even without a newline.
            if (!partial.includes("\n") && partial.length > MAX_PARTIAL_CHARS) {
                collected.push(partial);
                partial = "";
                if (collected.length >= maxLines) {
                    done = true;
                    child.kill();
                    return;
                }
            }

            const parts = partial.split("\n");
            // Last element is an incomplete line (or "" after a trailing \n)
            partial = parts.pop()!;

            for (const line of parts) {
                collected.push(line);
                if (collected.length >= maxLines) {
                    done = true;
                    child.kill();
                    return;
                }
            }
        });

        child.on("close", (code, signal) => {
            // Flush any trailing bytes held by the decoder (incomplete
            // multi-byte sequence at the very end of the stream).
            const trailing = stdoutDecoder.end();
            if (trailing) partial += trailing;
            const trailingErr = stderrDecoder.end();
            if (trailingErr && stderr.length < MAX_STDERR_CHARS) {
                stderr += trailingErr;
            }

            // Flush any remaining partial line if we haven't hit the cap
            if (!done && partial && collected.length < maxLines) {
                collected.push(partial);
            }
            // Hard-cap as a final safety net against post-kill data events
            resolve({
                lines: collected.slice(0, maxLines),
                exitCode: code,
                signal: signal as string | null,
                truncated: done,
                error: stderr || undefined,
            });
        });

        child.on("error", (err) => {
            resolve({
                lines: collected.slice(0, maxLines),
                exitCode: null,
                signal: null,
                truncated: done,
                error: err.message,
            });
        });
    });
}

/**
 * Determine whether a SpawnResult represents a real failure (vs. "no matches").
 *
 * - `rg` exit 1 = no matches (normal), exit 2+ = error.
 * - `find` exit 0 = success (possibly no matches), exit 1+ = error.
 * - exitCode null with no truncation = timeout or command not found.
 */
function isFailure(result: SpawnResult, type: string): boolean {
    // Truncated kill is intentional, not a failure
    if (result.truncated) return false;
    // exitCode null means process didn't exit normally (timeout, ENOENT, etc.)
    if (result.exitCode === null) return true;
    // rg: exit 1 = no matches, exit 0 = matches, exit 2+ = error
    if (type === "content") return result.exitCode >= 2;
    // find: exit 0 = success (no matches is just empty stdout), exit 1+ = error
    return result.exitCode !== 0;
}

export const searchTool: AgentTool = {
    name: "search",
    label: "Search",
    description: "Search for files or content using ripgrep or find",
    parameters: Type.Object({
        pattern: Type.String({ description: "Search pattern (regex for content, glob for files)" }),
        path: Type.String({ description: "Directory to search in" }),
        type: Type.Optional(
            Type.Union([Type.Literal("content"), Type.Literal("files")], {
                description: "'content' for grep, 'files' for find",
            }),
        ),
    }),
    async execute(_toolCallId, params: any) {
        const type = params.type ?? "content";

        // Normalize path so a leading "-" can't be mistaken for a flag/predicate.
        // This is the standard Unix idiom (e.g. `rm -- ./--help` vs `rm -- --help`).
        // GNU find/rg treat `./--help` as a literal path, not the --help flag.
        const safePath = /^[.\/]/.test(params.path) ? params.path : `./${params.path}`;

        // -e forces rg to treat pattern as a regex (not a flag); -- ends options before path.
        const [cmd, args, maxLines] =
            type === "files"
                ? (["find", [safePath, "-name", params.pattern, "-type", "f"], 50] as const)
                : (["rg", ["--no-heading", "-n", "-e", params.pattern, "--", safePath], 100] as const);

        const result = await spawnHeadLines(cmd, [...args], maxLines, 15_000);

        // Normalize type for isFailure — unknown values fall through to "content"
        // (rg branch) in command selection, so must match here too.
        const normalizedType = type === "files" ? "files" : "content";

        let output: string;
        if (result.lines.length > 0) {
            output = result.lines.join("\n");
            // Surface partial errors (e.g. permission denied on some subdirs,
            // timeout with partial output) so the caller knows results may be incomplete.
            if (isFailure(result, normalizedType)) {
                const reason = result.error?.split("\n")[0]
                    || (result.exitCode === null ? "process terminated unexpectedly" : `exit code ${result.exitCode}`);
                output += `\n\n[warning: some results may be missing — ${reason}]`;
            }
        } else if (isFailure(result, normalizedType)) {
            const reason = result.error?.split("\n")[0];
            if (result.exitCode === null && !result.truncated) {
                output = `Search failed: ${reason || "timed out or command not found"}`;
            } else {
                output = `Search failed: ${reason || `exit code ${result.exitCode}`}`;
            }
        } else {
            output = "No matches found";
        }

        return {
            content: [{ type: "text" as const, text: output }],
            details: { pattern: params.pattern, path: params.path, type: normalizedType },
        };
    },
};
