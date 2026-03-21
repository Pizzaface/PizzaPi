import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readFile } from "fs/promises";
import { validatePath } from "./sandbox.js";

export const readFileTool: AgentTool = {
    name: "read_file",
    label: "Read File",
    description: "Read the contents of a file",
    parameters: Type.Object({
        path: Type.String({ description: "Absolute path to the file" }),
    }),
    async execute(_toolCallId, params: any) {
        // Sandbox: validate read access before reading
        const validation = validatePath(params.path, "read");
        if (!validation.allowed) {
            const text = `❌ Sandbox blocked read of ${params.path} — ${validation.reason}`;
            return {
                content: [{ type: "text" as const, text }],
                details: { path: params.path, size: 0, sandboxBlocked: true },
            };
        }
        let content: string;
        try {
            content = await readFile(params.path, "utf-8");
        } catch (err: any) {
            const code: string = err.code ?? "";
            const reason =
                code === "ENOENT"
                    ? `File not found: ${params.path}`
                    : code === "EACCES"
                      ? `Permission denied: ${params.path}`
                      : code === "EISDIR"
                        ? `Path is a directory, not a file: ${params.path}`
                        : `Failed to read ${params.path}: ${err.message ?? String(err)}`;
            return {
                content: [{ type: "text" as const, text: `❌ ${reason}` }],
                details: { path: params.path, size: 0, error: code || err.message },
            };
        }
        return {
            content: [{ type: "text" as const, text: content }],
            details: { path: params.path, size: content.length },
        };
    },
};
