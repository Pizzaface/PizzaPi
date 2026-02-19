import type { Tool } from "@pizzapi/runtime";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const searchTool: Tool = {
    definition: {
        name: "search",
        description: "Search for files or content using ripgrep or find",
        parameters: {
            pattern: { type: "string", description: "Search pattern (regex)" },
            path: { type: "string", description: "Directory to search in" },
            type: { type: "string", description: "'content' for grep, 'files' for find", optional: true },
        },
    },
    async execute(args) {
        const pattern = args.pattern as string;
        const path = args.path as string;
        const type = (args.type as string) ?? "content";

        try {
            const command =
                type === "files"
                    ? `find ${path} -name "${pattern}" -type f 2>/dev/null | head -50`
                    : `rg --no-heading -n "${pattern}" ${path} 2>/dev/null | head -100`;

            const { stdout } = await execAsync(command, { timeout: 15_000 });
            return { success: true, output: stdout || "No matches found" };
        } catch (error) {
            return {
                success: false,
                output: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
