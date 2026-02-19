import type { Tool } from "@pizzapi/runtime";
import { readFile } from "fs/promises";

export const readFileTool: Tool = {
    definition: {
        name: "read_file",
        description: "Read the contents of a file",
        parameters: {
            path: { type: "string", description: "Absolute path to the file" },
        },
    },
    async execute(args) {
        const path = args.path as string;

        try {
            const content = await readFile(path, "utf-8");
            return { success: true, output: content };
        } catch (error) {
            return {
                success: false,
                output: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
