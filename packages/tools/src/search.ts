import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
        const command =
            type === "files"
                ? `find ${params.path} -name "${params.pattern}" -type f 2>/dev/null | head -50`
                : `rg --no-heading -n "${params.pattern}" ${params.path} 2>/dev/null | head -100`;

        const { stdout } = await execAsync(command, { timeout: 15_000 });
        const output = stdout || "No matches found";
        return {
            content: [{ type: "text" as const, text: output }],
            details: { pattern: params.pattern, path: params.path, type },
        };
    },
};
