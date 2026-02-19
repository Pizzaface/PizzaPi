import type { AgentTool } from "@mariozechner/pi-agent-core";
import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { searchTool } from "./search.js";

export function createToolkit(options?: { include?: string[]; exclude?: string[] }): AgentTool[] {
    const allTools: AgentTool[] = [bashTool, readFileTool, writeFileTool, searchTool];

    if (options?.include) {
        return allTools.filter((t) => options.include!.includes(t.name));
    }
    if (options?.exclude) {
        return allTools.filter((t) => !options.exclude!.includes(t.name));
    }

    return allTools;
}
