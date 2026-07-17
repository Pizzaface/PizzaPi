import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { exec } from "child_process";
import { promisify } from "util";
import { wrapCommand, getSandboxEnv, isSandboxActive } from "./sandbox.js";
import { resolvePosixShell } from "./posix-shell.js";

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
            if (!params || typeof params.command !== "string" || params.command.trim() === "") {
                const text = "❌ Invalid bash command: command must be a non-empty string.";
                return {
                    content: [{ type: "text" as const, text }],
                    details: { command: params?.command ?? "", stdout: "", stderr: text, validationError: true },
                };
            }

            const execAsync = promisify(execFn);
            const timeout = params.timeout ?? 30_000;
            // ponytail: 10 MB stdout+stderr cap; raise if a legitimate tool genuinely needs larger output
            const maxBuffer = 10 * 1024 * 1024;

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

            // The tool contract is bash semantics. On Windows exec() defaults to
            // cmd.exe, which breaks POSIX command strings — route through Git for
            // Windows' bash.exe when available (cmd.exe remains the last resort).
            const posixShell = process.platform === "win32" ? resolvePosixShell() : null;
            const shellOpt = posixShell ? { shell: posixShell.shell } : {};

            try {
                const { stdout, stderr } = await execAsync(command, { timeout, env, maxBuffer, ...shellOpt });
                return {
                    content: [{ type: "text" as const, text: stdout + (stderr ? `\nstderr: ${stderr}` : "") }],
                    details: { command: params.command, stdout, stderr },
                };
            } catch (error: any) {
                if (error?.code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") {
                    const partialStdout = error.stdout || "";
                    const partialStderr = error.stderr || "";
                    const text =
                        `Command output exceeded the ${maxBuffer} byte buffer and was truncated. Partial output follows:\n` +
                        partialStdout +
                        (partialStderr ? `\nstderr: ${partialStderr}` : "");
                    return {
                        content: [{ type: "text" as const, text }],
                        details: {
                            command: params.command,
                            stdout: partialStdout,
                            stderr: partialStderr,
                            truncated: true,
                        },
                    };
                }

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
