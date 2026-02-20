import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig, type PizzaPiConfig } from "../config.js";
import { registerMcpTools, type McpConfig } from "./mcp.js";
import { setMcpBridge } from "./mcp-bridge.js";

type McpServerConfigEntry = {
  name: string;
  transport: string;
  keyPath: string;
  format: "mcp.servers" | "mcpServers";
};

type McpConfigFileState = {
  scope: "global" | "project";
  path: string;
  exists: boolean;
  parseError?: string;
  hasMcpKey: boolean;
  hasMcpServersKey: boolean;
  preferredServers: McpServerConfigEntry[];
  compatibilityServers: McpServerConfigEntry[];
};

type EffectiveMcpServer = McpServerConfigEntry & {
  scope: "global" | "project";
  sourcePath: string;
};

type McpConfigInspection = {
  global: McpConfigFileState;
  project: McpConfigFileState;
  effectivePreferredSource: "global" | "project" | "none";
  effectiveCompatibilitySource: "global" | "project" | "none";
  effectiveServers: EffectiveMcpServer[];
};

type McpSnapshot = {
  toolCount: number;
  toolNames: string[];
  errors: Array<{ server: string; error: string }>;
  loadedAt: string;
  config: McpConfigInspection;
  summary: string;
  lines: string[];
};

type McpBridge = {
  status: () => McpSnapshot;
  reload: () => Promise<McpSnapshot>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseConfigFile(scope: "global" | "project", path: string): McpConfigFileState {
  if (!existsSync(path)) {
    return {
      scope,
      path,
      exists: false,
      hasMcpKey: false,
      hasMcpServersKey: false,
      preferredServers: [],
      compatibilityServers: [],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return {
      scope,
      path,
      exists: true,
      parseError: err instanceof Error ? err.message : String(err),
      hasMcpKey: false,
      hasMcpServersKey: false,
      preferredServers: [],
      compatibilityServers: [],
    };
  }

  if (!isRecord(raw)) {
    return {
      scope,
      path,
      exists: true,
      parseError: "Top-level JSON value must be an object",
      hasMcpKey: false,
      hasMcpServersKey: false,
      preferredServers: [],
      compatibilityServers: [],
    };
  }

  const hasMcpKey = Object.prototype.hasOwnProperty.call(raw, "mcp");
  const hasMcpServersKey = Object.prototype.hasOwnProperty.call(raw, "mcpServers");

  const preferredServers: McpServerConfigEntry[] = [];
  if (isRecord(raw.mcp) && Array.isArray(raw.mcp.servers)) {
    for (let i = 0; i < raw.mcp.servers.length; i++) {
      const entry = raw.mcp.servers[i];
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `(unnamed-${i + 1})`;
      const transport = typeof entry.transport === "string" ? entry.transport : "unknown";
      preferredServers.push({
        name,
        transport,
        keyPath: `mcp.servers[${i}]`,
        format: "mcp.servers",
      });
    }
  }

  const compatibilityServers: McpServerConfigEntry[] = [];
  if (isRecord(raw.mcpServers)) {
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      let transport = "unknown";
      if (isRecord(value) && typeof value.command === "string") {
        transport = "stdio";
      } else if (isRecord(value) && typeof value.url === "string") {
        transport = typeof value.transport === "string" ? value.transport : "http";
      }

      compatibilityServers.push({
        name,
        transport,
        keyPath: `mcpServers.${name}`,
        format: "mcpServers",
      });
    }
  }

  return {
    scope,
    path,
    exists: true,
    hasMcpKey,
    hasMcpServersKey,
    preferredServers,
    compatibilityServers,
  };
}

function inspectMcpConfig(cwd: string): McpConfigInspection {
  const globalPath = join(homedir(), ".pizzapi", "config.json");
  const projectPath = join(cwd, ".pizzapi", "config.json");

  const global = parseConfigFile("global", globalPath);
  const project = parseConfigFile("project", projectPath);

  const effectivePreferredSource: "global" | "project" | "none" = project.hasMcpKey
    ? "project"
    : global.hasMcpKey
      ? "global"
      : "none";

  const effectiveCompatibilitySource: "global" | "project" | "none" = project.hasMcpServersKey
    ? "project"
    : global.hasMcpServersKey
      ? "global"
      : "none";

  const effectiveServers: EffectiveMcpServer[] = [];

  if (effectivePreferredSource !== "none") {
    const source = effectivePreferredSource === "project" ? project : global;
    for (const entry of source.preferredServers) {
      effectiveServers.push({
        ...entry,
        scope: source.scope,
        sourcePath: source.path,
      });
    }
  }

  if (effectiveCompatibilitySource !== "none") {
    const source = effectiveCompatibilitySource === "project" ? project : global;
    for (const entry of source.compatibilityServers) {
      effectiveServers.push({
        ...entry,
        scope: source.scope,
        sourcePath: source.path,
      });
    }
  }

  return {
    global,
    project,
    effectivePreferredSource,
    effectiveCompatibilitySource,
    effectiveServers,
  };
}

function formatFileState(file: McpConfigFileState): string {
  if (!file.exists) return `${file.scope}: ${file.path} (missing)`;
  if (file.parseError) return `${file.scope}: ${file.path} (invalid JSON: ${file.parseError})`;
  return `${file.scope}: ${file.path} (ok)`;
}

function buildStatusLines(snapshot: McpSnapshot): string[] {
  const lines: string[] = [];
  lines.push(`MCP tools loaded: ${snapshot.toolCount}`);
  lines.push(`Configured MCP server entries: ${snapshot.config.effectiveServers.length}`);

  if (snapshot.toolNames.length > 0) {
    lines.push("");
    lines.push("Tools:");
    for (const name of snapshot.toolNames.slice(0, 50)) lines.push(`- ${name}`);
    if (snapshot.toolNames.length > 50) lines.push(`…and ${snapshot.toolNames.length - 50} more`);
  }

  if (snapshot.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of snapshot.errors) lines.push(`- ${e.server}: ${e.error}`);
  }

  lines.push("");
  lines.push("Config files:");
  lines.push(`- ${formatFileState(snapshot.config.global)}`);
  lines.push(`- ${formatFileState(snapshot.config.project)}`);

  lines.push("");
  lines.push("Effective config sources (project overrides global by top-level key):");
  lines.push(`- mcp.servers: ${snapshot.config.effectivePreferredSource}`);
  lines.push(`- mcpServers: ${snapshot.config.effectiveCompatibilitySource}`);

  if (snapshot.config.effectiveServers.length > 0) {
    lines.push("");
    lines.push("Effective server entries:");
    for (const server of snapshot.config.effectiveServers) {
      lines.push(`- ${server.name} [${server.transport}] from ${server.scope} (${server.sourcePath} :: ${server.keyPath})`);
    }
  } else {
    lines.push("");
    lines.push("No MCP server entries are currently configured.");
  }

  lines.push("");
  lines.push(`Last loaded: ${snapshot.loadedAt}`);

  return lines;
}

/**
 * MCP extension.
 *
 * Reads MCP server definitions from ~/.pizzapi/config.json (and project .pizzapi/config.json)
 * and registers MCP tools as pi tools.
 */
export const mcpExtension: ExtensionFactory = async (pi: any) => {
  let activeClients: Array<{ close: () => void }> = [];

  let lastSnapshot: McpSnapshot = {
    toolCount: 0,
    toolNames: [],
    errors: [],
    loadedAt: new Date(0).toISOString(),
    config: inspectMcpConfig(process.cwd()),
    summary: "MCP tools loaded: 0",
    lines: ["MCP tools loaded: 0"],
  };

  async function load() {
    const mergedConfig = loadConfig(process.cwd()) as PizzaPiConfig & McpConfig;
    const inspection = inspectMcpConfig(process.cwd());
    const res = await registerMcpTools(pi, mergedConfig);

    for (const client of activeClients) {
      try {
        client.close();
      } catch {
        // ignore best-effort shutdown errors
      }
    }
    activeClients = Array.isArray(res.clients) ? res.clients : [];

    const loadedAt = new Date().toISOString();
    const toolCount = res.toolCount ?? 0;
    const toolNames = Array.isArray((res as any).toolNames) ? (res as any).toolNames : [];
    const errors = Array.isArray((res as any).errors) ? (res as any).errors : [];

    const summary = `MCP tools loaded: ${toolCount}`;

    lastSnapshot = {
      toolCount,
      toolNames,
      errors,
      loadedAt,
      config: inspection,
      summary,
      lines: [],
    };
    lastSnapshot.lines = buildStatusLines(lastSnapshot);

    return lastSnapshot;
  }

  const bridge: McpBridge = {
    status: () => lastSnapshot,
    reload: () => load(),
  };
  setMcpBridge(bridge);

  try {
    await load();
  } catch {
    // No UI available here (no ExtensionContext in factory), so swallow.
    // The user can diagnose via /mcp once UI is up.
  }

  pi.registerCommand?.("mcp", {
    description: "Show MCP status, or: /mcp reload",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      return "reload".startsWith(normalized) ? [{ value: "reload", label: "reload" }] : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "reload") {
        ctx?.ui?.notify?.("Reloading MCP tools…");
        try {
          const snapshot = await load();
          ctx?.ui?.notify?.(snapshot.lines.join("\n"));
        } catch (err) {
          ctx?.ui?.notify?.(`MCP reload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      const snapshot = lastSnapshot;
      ctx?.ui?.notify?.(snapshot.lines.join("\n"));
    },
  });

  pi.on?.("session_shutdown", () => {
    for (const client of activeClients) {
      try {
        client.close();
      } catch {
        // ignore best-effort shutdown errors
      }
    }
    activeClients = [];
    setMcpBridge(null);
  });
};
