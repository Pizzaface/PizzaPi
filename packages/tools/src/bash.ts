import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { exec } from "child_process";
import { promisify } from "util";
import { wrapCommand, getSandboxEnv, isSandboxActive } from "./sandbox.js";

const execAsync = promisify(exec);

export const bashTool: AgentTool = {
    name: "bash",
    label: "Bash",
    description: "Execute a bash command and return its output",
    parameters: Type.Object({
        command: Type.String({ description: "The command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
    }),
    async execute(_toolCallId, params: any) {
        const timeout = params.timeout ?? 30_000;

        let command: string = params.command;
        let env: NodeJS.ProcessEnv = process.env;

        // Sandbox integration: wrap command and inject proxy env vars
        if (isSandboxActive()) {
            try {
                command = await wrapCommand(params.command);
                env = { ...process.env, ...getSandboxEnv() };
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                const text = `❌ Sandbox blocked: ${reason}. To allow, update sandbox config.`;
                return {
                    content: [{ type: "text" as const, text }],
                    details: { command: params.command, stdout: "", stderr: text, sandboxBlocked: true },
                };
            }
        }

        try {
            const { stdout, stderr } = await execAsync(command, { timeout, env });
            return {
                content: [{ type: "text" as const, text: stdout + (stderr ? `\nstderr: ${stderr}` : "") }],
                details: { command: params.command, stdout, stderr },
            };
        } catch (error: any) {
            // execAsync throws on non-zero exit code.
            // Return stdout/stderr rather than crashing the tool call.
            const stdout = error.stdout || "";
            const stderr = error.stderr || error.message || String(error);
            return {
                content: [{ type: "text" as const, text: stdout + (stderr ? `\nstderr: ${stderr}` : "") }],
                details: { command: params.command, stdout, stderr, exitCode: error.code },
            };
        }
    },
};
