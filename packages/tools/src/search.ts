import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Truncate output to the first `maxLines` lines. */
function truncateLines(text: string, maxLines: number): string {
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join("\n");
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

        let stdout: string;
        let maxLines: number;

        if (type === "files") {
            // Use execFile to safely pass arguments without a shell
            const result = await execFileAsync(
                "find",
                [params.path, "-name", params.pattern, "-type", "f"],
                { timeout: 15_000 },
            ).catch((err) => ({ stdout: err.stdout ?? "", stderr: err.stderr ?? "" }));
            stdout = result.stdout;
            maxLines = 50;
        } else {
            const result = await execFileAsync(
                "rg",
                ["--no-heading", "-n", params.pattern, params.path],
                { timeout: 15_000 },
            ).catch((err) => ({ stdout: err.stdout ?? "", stderr: err.stderr ?? "" }));
            stdout = result.stdout;
            maxLines = 100;
        }

        const output = truncateLines(stdout, maxLines) || "No matches found";
        return {
            content: [{ type: "text" as const, text: output }],
            details: { pattern: params.pattern, path: params.path, type },
        };
    },
};
