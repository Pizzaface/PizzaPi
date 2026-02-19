import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const bashTool: AgentTool = {
    name: "bash",
    label: "Bash",
    description: "Execute a bash command and return its output",
    parameters: Type.Object({
        command: Type.String({ description: "The command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
    }),
    async execute(_toolCallId, params) {
        const timeout = params.timeout ?? 30_000;
        const { stdout, stderr } = await execAsync(params.command, { timeout });
        return {
            content: [{ type: "text" as const, text: stdout + (stderr ? `\nstderr: ${stderr}` : "") }],
            details: { command: params.command, stdout, stderr },
        };
    },
};
