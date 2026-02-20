import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";
import { registerMcpTools } from "./mcp.js";

/**
 * MCP extension.
 *
 * Reads MCP server definitions from ~/.pizzapi/config.json (and project .pizzapi/config.json)
 * and registers MCP tools as pi tools.
 */
export const mcpExtension: ExtensionFactory = async (pi: any) => {
  // We intentionally keep this loosely typed because we only need the ExtensionAPI.
  // Config is loaded from global/project files.
  const config = loadConfig(process.cwd());

  // Load tools once on startup.
  let lastSnapshot: {
    toolCount: number;
    toolNames: string[];
    errors: Array<{ server: string; error: string }>;
  } = { toolCount: 0, toolNames: [], errors: [] };

  async function load() {
    const res = await registerMcpTools(pi, config as any);
    lastSnapshot = {
      toolCount: res.toolCount ?? 0,
      toolNames: Array.isArray((res as any).toolNames) ? (res as any).toolNames : [],
      errors: Array.isArray((res as any).errors) ? (res as any).errors : [],
    };
    return lastSnapshot;
  }

  try {
    await load();
  } catch {
    // No UI available here (no ExtensionContext in factory), so swallow.
    // The user can diagnose via /mcp once UI is up.
  }

  // Slash command: /mcp (status) | /mcp reload
  pi.registerCommand?.("mcp", {
    description: "Show MCP status, or: /mcp reload",
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "reload") {
        ctx?.ui?.notify?.("Reloading MCP tools…");
        try {
          const snap = await load();
          const lines: string[] = [];
          lines.push(`MCP tools loaded: ${snap.toolCount}`);
          if (snap.errors.length > 0) {
            lines.push("");
            lines.push("Errors:");
            for (const e of snap.errors) lines.push(`- ${e.server}: ${e.error}`);
          }
          ctx?.ui?.notify?.(lines.join("\n"));
        } catch (err) {
          ctx?.ui?.notify?.(`MCP reload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      const snap = lastSnapshot;
      const lines: string[] = [];
      lines.push(`MCP tools loaded: ${snap.toolCount}`);
      if (snap.toolNames.length > 0) {
        lines.push("");
        lines.push("Tools:");
        for (const name of snap.toolNames.slice(0, 50)) lines.push(`- ${name}`);
        if (snap.toolNames.length > 50) lines.push(`…and ${snap.toolNames.length - 50} more`);
      }
      if (snap.errors.length > 0) {
        lines.push("");
        lines.push("Errors:");
        for (const e of snap.errors) lines.push(`- ${e.server}: ${e.error}`);
      }

      ctx?.ui?.notify?.(lines.join("\n"));
    },
  });
};
