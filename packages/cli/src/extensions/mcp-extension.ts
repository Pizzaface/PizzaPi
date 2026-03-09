import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig, type PizzaPiConfig } from "../config.js";
import { registerMcpTools, type McpConfig, type McpServerInitResult, type McpRegistrationResult, getOAuthProviders } from "./mcp.js";
import { setMcpBridge } from "./mcp-bridge.js";
import type { RelayContext } from "./mcp-oauth.js";

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
  /** Tools grouped by MCP server name */
  serverTools: Record<string, string[]>;
  errors: Array<{ server: string; error: string }>;
  loadedAt: string;
  config: McpConfigInspection;
  summary: string;
  lines: string[];
  /** Per-server init timing breakdown (available after first load). */
  serverTimings: McpServerInitResult[];
  /** Total wall-clock MCP initialization time (ms). */
  totalDurationMs: number;
};

type McpBridge = {
  status: () => McpSnapshot;
  reload: () => Promise<McpSnapshot>;
  setRelayContext: (ctx: RelayContext | null) => void;
  deliverOAuthCallback: (nonce: string, code: string) => void;
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
        // "transport" is our field; "type" is Claude Code / VS Code format.
        // In the standard MCP ecosystem, type "http" = streamable HTTP.
        if (typeof value.transport === "string") {
          transport = value.transport;
        } else if (value.type === "http") {
          transport = "streamable";
        } else if (typeof value.type === "string") {
          transport = value.type;
        } else {
          transport = "http";
        }
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

  // Per-server timing breakdown
  if (snapshot.serverTimings.length > 0) {
    lines.push("");
    lines.push("Server init timing:");
    for (const timing of snapshot.serverTimings) {
      const status = timing.error
        ? (timing.timedOut ? "⏱ timed out" : `✗ ${timing.error}`)
        : `✓ ${timing.tools.length} tool${timing.tools.length !== 1 ? "s" : ""}`;
      const dur = timing.durationMs >= 1000
        ? `${(timing.durationMs / 1000).toFixed(1)}s`
        : `${timing.durationMs}ms`;
      lines.push(`- ${timing.name}: ${status} (${dur})`);
    }
    if (snapshot.totalDurationMs > 0) {
      const totalDur = snapshot.totalDurationMs >= 1000
        ? `${(snapshot.totalDurationMs / 1000).toFixed(1)}s`
        : `${snapshot.totalDurationMs}ms`;
      lines.push(`Total MCP init: ${totalDur}`);
    }
  }

  lines.push("");
  lines.push(`Last loaded: ${snapshot.loadedAt}`);

  return lines;
}

/** Threshold (ms) above which we warn about slow MCP startup. */
const SLOW_STARTUP_THRESHOLD_MS = 5_000;

/** Threshold (ms) above which an individual server is flagged as slow. */
const SLOW_SERVER_THRESHOLD_MS = 3_000;

/**
 * Build a startup_report event payload for forwarding to the web UI.
 * Emitted as a pi.events custom event so the remote extension can pick it up.
 */
export type McpStartupReport = {
  type: "mcp_startup_report";
  toolCount: number;
  serverCount: number;
  totalDurationMs: number;
  errors: Array<{ server: string; error: string }>;
  serverTimings: Array<{
    name: string;
    durationMs: number;
    toolCount: number;
    timedOut: boolean;
    error?: string;
  }>;
  slow: boolean;
  /** Whether slow-startup warnings should be shown (from config). Errors are always shown. */
  showSlowWarning: boolean;
  ts: number;
};

/**
 * MCP extension.
 *
 * Reads MCP server definitions from ~/.pizzapi/config.json (and project .pizzapi/config.json)
 * and registers MCP tools as pi tools.
 *
 * Features:
 * - Per-server timeouts (configurable via `mcpTimeout` in config, default 30s)
 * - Parallel server initialization
 * - Startup timing breakdown
 * - Slow-startup warnings in TUI and web UI (disableable via `slowStartupWarning: false`)
 */
export const mcpExtension: ExtensionFactory = async (pi: any) => {
  let activeClients: Array<{ close: () => void }> = [];

  let lastSnapshot: McpSnapshot = {
    toolCount: 0,
    toolNames: [],
    serverTools: {},
    errors: [],
    loadedAt: new Date(0).toISOString(),
    config: inspectMcpConfig(process.cwd()),
    summary: "MCP tools loaded: 0",
    lines: ["MCP tools loaded: 0"],
    serverTimings: [],
    totalDurationMs: 0,
  };

  // Stash the last registration result so session_start can build reports.
  let lastRegistrationResult: McpRegistrationResult | null = null;

  async function load(): Promise<McpSnapshot> {
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
    lastRegistrationResult = res;

    const loadedAt = new Date().toISOString();

    const summary = `MCP tools loaded: ${res.toolCount}`;

    lastSnapshot = {
      toolCount: res.toolCount,
      toolNames: res.toolNames,
      serverTools: res.serverTools,
      errors: res.errors,
      loadedAt,
      config: inspection,
      summary,
      lines: [],
      serverTimings: res.serverTimings,
      totalDurationMs: res.totalDurationMs,
    };
    lastSnapshot.lines = buildStatusLines(lastSnapshot);

    return lastSnapshot;
  }

  /** Build a startup report event from the last registration result. */
  function buildStartupReport(): McpStartupReport | null {
    if (!lastRegistrationResult) return null;
    const res = lastRegistrationResult;
    const cfg = loadConfig(process.cwd());
    return {
      type: "mcp_startup_report",
      toolCount: res.toolCount,
      serverCount: res.serverTimings.length,
      totalDurationMs: res.totalDurationMs,
      errors: res.errors,
      serverTimings: res.serverTimings.map((t) => ({
        name: t.name,
        durationMs: t.durationMs,
        toolCount: t.tools.length,
        timedOut: t.timedOut,
        error: t.error,
      })),
      slow: res.totalDurationMs >= SLOW_STARTUP_THRESHOLD_MS,
      showSlowWarning: cfg.slowStartupWarning !== false,
      ts: Date.now(),
    };
  }

  // ── OAuth relay support ──────────────────────────────────────────────────
  // Pending OAuth callbacks: nonce → resolve(code)
  const pendingOAuthCallbacks = new Map<string, (code: string) => void>();

  const bridge: McpBridge = {
    status: () => lastSnapshot,
    reload: () => load(),

    setRelayContext(ctx: RelayContext | null) {
      // Propagate relay context to all active OAuth providers
      for (const provider of getOAuthProviders()) {
        provider.relayContext = ctx;
      }
    },

    deliverOAuthCallback(nonce: string, code: string) {
      const resolve = pendingOAuthCallbacks.get(nonce);
      if (resolve) {
        pendingOAuthCallbacks.delete(nonce);
        resolve(code);
      }
    },
  };
  setMcpBridge(bridge);

  // Expose the callback-wait function so OAuth providers can use it
  // (relay context's waitForCallback delegates here).
  (bridge as any)._pendingOAuthCallbacks = pendingOAuthCallbacks;

  try {
    await load();
  } catch {
    // No UI available here (no ExtensionContext in factory), so swallow.
    // The user can diagnose via /mcp once UI is up.
  }

  // ── session_start: report timing to TUI + emit events for web UI ─────────
  pi.on?.("session_start", async (_event: any, ctx: any) => {
    const config = loadConfig(process.cwd());
    const showWarnings = config.slowStartupWarning !== false;
    const report = buildStartupReport();

    if (!report) return;

    // Always emit the startup report event so the remote extension can
    // forward it to the web UI (the web UI decides whether to render it).
    pi.events?.emit?.("mcp:startup_report", report);

    // TUI notifications
    if (report.errors.length > 0) {
      const errSummary = report.errors
        .map((e) => `  • ${e.server}: ${e.error}`)
        .join("\n");
      ctx?.ui?.notify?.(
        `⚠ MCP server errors:\n${errSummary}\n\nUse /mcp for details, or --no-mcp to skip.`,
        "warning",
      );
    }

    if (showWarnings && report.slow) {
      const slowServers = report.serverTimings
        .filter((t) => t.durationMs >= SLOW_SERVER_THRESHOLD_MS)
        .map((t) => {
          const dur = t.durationMs >= 1000
            ? `${(t.durationMs / 1000).toFixed(1)}s`
            : `${t.durationMs}ms`;
          return `  • ${t.name}: ${dur}${t.timedOut ? " (timed out)" : ""}`;
        });

      const totalDur = report.totalDurationMs >= 1000
        ? `${(report.totalDurationMs / 1000).toFixed(1)}s`
        : `${report.totalDurationMs}ms`;

      const lines = [`⏱ MCP startup took ${totalDur}`];
      if (slowServers.length > 0) {
        lines.push("Slow servers:");
        lines.push(...slowServers);
      }
      lines.push("");
      lines.push("Tip: Use --safe-mode or --no-mcp for instant startup.");
      lines.push("Disable this warning: set slowStartupWarning: false in config.");

      ctx?.ui?.notify?.(lines.join("\n"), "warning");
    }
  });

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
          // Emit report so web UI can update
          const report = buildStartupReport();
          if (report) pi.events?.emit?.("mcp:startup_report", report);
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
