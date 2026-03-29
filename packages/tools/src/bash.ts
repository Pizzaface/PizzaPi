import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { exec } from "child_process";
import { promisify } from "util";
import { wrapCommand, getSandboxEnv, isSandboxActive } from "./sandbox.js";

// ── Internal types for dependency injection (used in tests) ───────────────────

export interface BashDeps {
    execFn: typeof exec;
    isSandboxActiveFn: () => boolean;
    getSandboxEnvFn: () => Record<string, string>;
    wrapCommandFn: (cmd: string) => Promise<string>;
}

// ── Factory (accepts injected deps; defaults to real implementations) ─────────

export function createBashTool(deps?: Partial<BashDeps>): AgentTool {
    const execFn = deps?.execFn ?? exec;
    const isSandboxActiveFn = deps?.isSandboxActiveFn ?? isSandboxActive;
    const getSandboxEnvFn = deps?.getSandboxEnvFn ?? getSandboxEnv;
    const wrapCommandFn = deps?.wrapCommandFn ?? wrapCommand;

    return {
        name: "bash",
        label: "Bash",
        description: "Execute a bash command and return its output",
        parameters: Type.Object({
            command: Type.String({ description: "The command to execute" }),
            timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
        }),
        async execute(_toolCallId, params: any) {
            const execAsync = promisify(execFn);
            const timeout = params.timeout ?? 30_000;

            let command: string = params.command;
            let env: NodeJS.ProcessEnv = process.env;

            // Sandbox integration: wrap command and inject proxy env vars
            if (isSandboxActiveFn()) {
                try {
                    command = await wrapCommandFn(params.command);
                    env = { ...process.env, ...getSandboxEnvFn() };
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
}

// ── Default export — uses real implementations ────────────────────────────────

export const bashTool = createBashTool();
