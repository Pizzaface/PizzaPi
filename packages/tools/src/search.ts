import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { spawn } from "child_process";

interface SpawnResult {
    lines: string[];
    exitCode: number | null;
    signal: string | null;
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
        let stderrChunks: string[] = [];

        child.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
        });

        child.stdout.on("data", (chunk: Buffer) => {
            if (done) return;

            partial += chunk.toString();
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
            // Flush any remaining partial line if we haven't hit the cap
            if (!done && partial && collected.length < maxLines) {
                collected.push(partial);
            }
            // Hard-cap as a final safety net against post-kill data events
            resolve({
                lines: collected.slice(0, maxLines),
                exitCode: code,
                signal: signal as string | null,
                error: stderrChunks.length ? stderrChunks.join("").slice(0, 500) : undefined,
            });
        });

        child.on("error", (err) => {
            resolve({
                lines: collected.slice(0, maxLines),
                exitCode: null,
                signal: null,
                error: err.message,
            });
        });
    });
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

        let output: string;
        if (result.lines.length > 0) {
            output = result.lines.join("\n");
        } else if (result.error && result.exitCode !== 1) {
            // exitCode 1 is normal "no matches" for rg/find — anything else is a real error
            output = `Search failed: ${result.error.split("\n")[0]}`;
        } else {
            output = "No matches found";
        }

        return {
            content: [{ type: "text" as const, text: output }],
            details: { pattern: params.pattern, path: params.path, type },
        };
    },
};
