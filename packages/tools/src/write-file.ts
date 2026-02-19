import type { Tool } from "@pizzapi/runtime";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

export const writeFileTool: Tool = {
    definition: {
        name: "write_file",
        description: "Write content to a file, creating directories as needed",
        parameters: {
            path: { type: "string", description: "Absolute path to the file" },
            content: { type: "string", description: "Content to write" },
        },
    },
    async execute(args) {
        const path = args.path as string;
        const content = args.content as string;

        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, "utf-8");
            return { success: true, output: `Wrote ${content.length} bytes to ${path}` };
        } catch (error) {
            return {
                success: false,
                output: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
