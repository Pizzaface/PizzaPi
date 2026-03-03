import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { spawn } from "child_process";

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
): Promise<string> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: timeoutMs,
        });

        const collected: string[] = [];
        let partial = "";

        child.stdout.on("data", (chunk: Buffer) => {
            partial += chunk.toString();
            const parts = partial.split("\n");
            // Last element is an incomplete line (or "" after a trailing \n)
            partial = parts.pop()!;

            for (const line of parts) {
                collected.push(line);
                if (collected.length >= maxLines) {
                    child.kill();
                    return;
                }
            }
        });

        child.on("close", () => {
            // Flush any remaining partial line if we haven't hit the cap
            if (partial && collected.length < maxLines) {
                collected.push(partial);
            }
            resolve(collected.join("\n"));
        });

        child.on("error", () => {
            resolve(collected.join("\n"));
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

        const [cmd, args, maxLines] =
            type === "files"
                ? (["find", [params.path, "-name", params.pattern, "-type", "f"], 50] as const)
                : (["rg", ["--no-heading", "-n", params.pattern, params.path], 100] as const);

        const stdout = await spawnHeadLines(cmd, [...args], maxLines, 15_000);

        const output = stdout || "No matches found";
        return {
            content: [{ type: "text" as const, text: output }],
            details: { pattern: params.pattern, path: params.path, type },
        };
    },
};
