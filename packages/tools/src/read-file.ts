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
        const content = await readFile(params.path, "utf-8");
        return {
            content: [{ type: "text" as const, text: content }],
            details: { path: params.path, size: content.length },
        };
    },
};
