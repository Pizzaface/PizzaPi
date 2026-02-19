import type { Tool } from "@pizzapi/runtime";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const bashTool: Tool = {
    definition: {
        name: "bash",
        description: "Execute a bash command and return its output",
        parameters: {
            command: { type: "string", description: "The command to execute" },
            timeout: { type: "number", description: "Timeout in milliseconds", optional: true },
        },
    },
    async execute(args) {
        const command = args.command as string;
        const timeout = (args.timeout as number) ?? 30_000;

        try {
            const { stdout, stderr } = await execAsync(command, { timeout });
            return {
                success: true,
                output: { stdout, stderr },
            };
        } catch (error) {
            return {
                success: false,
                output: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
