import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { validatePath } from "./sandbox.js";

export const writeFileTool: AgentTool = {
    name: "write_file",
    label: "Write File",
    description: "Write content to a file, creating directories as needed",
    parameters: Type.Object({
        path: Type.String({ description: "Absolute path to the file" }),
        content: Type.String({ description: "Content to write" }),
    }),
    async execute(_toolCallId, params: any) {
        // Sandbox: validate write access before writing
        const validation = validatePath(params.path, "write");
        if (!validation.allowed) {
            const text = `❌ Sandbox blocked write to ${params.path} — ${validation.reason}. Update sandbox.filesystem.allowWrite in config.`;
            return {
                content: [{ type: "text" as const, text }],
                details: { path: params.path, size: 0, sandboxBlocked: true },
            };
        }
        try {
            await mkdir(dirname(params.path), { recursive: true });
            await writeFile(params.path, params.content, "utf-8");
        } catch (err: any) {
            const code: string = err.code ?? "";
            const reason =
                code === "EACCES"
                    ? `Permission denied: ${params.path}`
                    : code === "ENOSPC"
                      ? `No space left on device while writing: ${params.path}`
                      : code === "EISDIR"
                        ? `Path is a directory, not a file: ${params.path}`
                        : code === "ENOENT"
                          ? `Parent directory could not be created for: ${params.path}`
                          : `Failed to write ${params.path}: ${err.message ?? String(err)}`;
            return {
                content: [{ type: "text" as const, text: `❌ ${reason}` }],
                details: { path: params.path, size: 0, error: code || err.message },
            };
        }
        return {
            content: [{ type: "text" as const, text: `Wrote ${params.content.length} bytes to ${params.path}` }],
            details: { path: params.path, size: params.content.length },
        };
    },
};
