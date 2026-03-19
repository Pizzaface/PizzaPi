import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig, toggleMcpServer, globalConfigDir, type PizzaPiConfig } from "../config.js";
import {
  registerMcpTools,
  type McpConfig,
  type McpServerInitResult,
  type McpRegistrationResult,
  getOAuthProviders,
  setDeferOAuthRelayWaitTimeoutUntilAnchor,
  markOAuthRelayWaitAnchorReady,
} from "./mcp.js";
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
  effectivePreferredSource: "global" | "project" | "both" | "none";
  effectiveCompatibilitySource: "global" | "project" | "both" | "none";
  effectiveServers: EffectiveMcpServer[];
  /** Server names disabled via disabledMcpServers in global and/or project config. */
  disabledServers: string[];
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
  const globalPath = join(globalConfigDir(), "config.json");
  const projectPath = join(cwd, ".pizzapi", "config.json");

  const global = parseConfigFile("global", globalPath);
  const project = parseConfigFile("project", projectPath);

  // Determine effective sources — "both" when both scopes define the key
  const effectivePreferredSource: "global" | "project" | "both" | "none" =
    global.hasMcpKey && project.hasMcpKey
      ? "both"
      : project.hasMcpKey
        ? "project"
        : global.hasMcpKey
          ? "global"
          : "none";

  const effectiveCompatibilitySource: "global" | "project" | "both" | "none" =
    global.hasMcpServersKey && project.hasMcpServersKey
      ? "both"
      : project.hasMcpServersKey
        ? "project"
        : global.hasMcpServersKey
          ? "global"
          : "none";

  const effectiveServers: EffectiveMcpServer[] = [];

  // mcp.servers (preferred format): merge by server name, project wins on conflicts
  if (effectivePreferredSource !== "none") {
    if (effectivePreferredSource === "both") {
      // Merge: start with global, project overwrites by name
      const serverMap = new Map<string, EffectiveMcpServer>();
      for (const entry of global.preferredServers) {
        serverMap.set(entry.name, { ...entry, scope: "global", sourcePath: global.path });
      }
      for (const entry of project.preferredServers) {
        serverMap.set(entry.name, { ...entry, scope: "project", sourcePath: project.path });
      }
      effectiveServers.push(...serverMap.values());
    } else {
      const source = effectivePreferredSource === "project" ? project : global;
      for (const entry of source.preferredServers) {
        effectiveServers.push({ ...entry, scope: source.scope, sourcePath: source.path });
      }
    }
  }

  // mcpServers (compatibility format): merge by server name, project wins on conflicts
  if (effectiveCompatibilitySource !== "none") {
    if (effectiveCompatibilitySource === "both") {
      const serverMap = new Map<string, EffectiveMcpServer>();
      for (const entry of global.compatibilityServers) {
        serverMap.set(entry.name, { ...entry, scope: "global", sourcePath: global.path });
      }
      for (const entry of project.compatibilityServers) {
        serverMap.set(entry.name, { ...entry, scope: "project", sourcePath: project.path });
      }
      effectiveServers.push(...serverMap.values());
    } else {
      const source = effectiveCompatibilitySource === "project" ? project : global;
      for (const entry of source.compatibilityServers) {
        effectiveServers.push({ ...entry, scope: source.scope, sourcePath: source.path });
      }
    }
  }

  // Collect disabled server names from merged config
  const mergedConfig = loadConfig(cwd);
  const disabledServers = mergedConfig.disabledMcpServers ?? [];

  return {
    global,
    project,
    effectivePreferredSource,
    effectiveCompatibilitySource,
    effectiveServers,
    disabledServers,
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
    const disabledSet = new Set(snapshot.config.disabledServers);
    for (const server of snapshot.config.effectiveServers) {
      const disabledTag = disabledSet.has(server.name) ? " [DISABLED]" : "";
      lines.push(`- ${server.name} [${server.transport}]${disabledTag} from ${server.scope} (${server.sourcePath} :: ${server.keyPath})`);
    }
  } else {
    lines.push("");
    lines.push("No MCP server entries are currently configured.");
  }

  if (snapshot.config.disabledServers.length > 0) {
    lines.push("");
    lines.push("Disabled servers:");
    for (const name of snapshot.config.disabledServers) {
      lines.push(`- ${name} (skipped — /mcp enable ${name} to re-enable)`);
    }
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

    // Remember previous MCP tool names so we can update active tools after reload.
    const previousMcpToolNames = new Set(lastSnapshot.toolNames);

    // Pass current relay context so that freshly created OAuth providers have
    // it *before* initialization begins.  During /mcp reload the relay is
    // already connected — without this, providers fall back to local OAuth.
    // During initial session_start, currentRelayContext is null (relay hasn't
    // connected yet) and providers use waitForRelayContext() as before.
    const res = await registerMcpTools(pi, mergedConfig, currentRelayContext);

    for (const client of activeClients) {
      try {
        client.close();
      } catch {
        // ignore best-effort shutdown errors
      }
    }
    activeClients = Array.isArray(res.clients) ? res.clients : [];
    lastRegistrationResult = res;

    // ── Reconcile active tools ──────────────────────────────────────────
    // pi.registerTool() auto-activates genuinely *new* tools via refreshTools(),
    // but two cases aren't handled by that mechanism:
    //
    //  1. Disabled/removed servers: their tools stay active as zombies because
    //     refreshTools() preserves previousActiveToolNames and nothing removes
    //     tools that disappeared from the registry.
    //
    //  2. Re-enabled servers: their tools overwrite zombie definitions in
    //     extension.tools (same name), so refreshTools() sees them as existing
    //     registry entries and does NOT auto-activate them.
    //
    // Fix: after all registerTool() calls, explicitly set active tools —
    // removing stale MCP tools and ensuring new/re-enabled ones are included.
    const newMcpToolNames = new Set(res.toolNames);
    const currentActive = new Set(pi.getActiveTools() as string[]);

    // Remove tools from disabled/removed servers
    for (const old of previousMcpToolNames) {
      if (!newMcpToolNames.has(old)) {
        currentActive.delete(old);
      }
    }
    // Ensure all current MCP tools are active (handles re-enable after disable)
    for (const name of newMcpToolNames) {
      currentActive.add(name);
    }
    pi.setActiveTools([...currentActive]);

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

  // Stash the current relay context so it can be reapplied after /mcp reload
  // creates fresh OAuth providers (which start with relayContext = null).
  let currentRelayContext: RelayContext | null = null;

  const bridge: McpBridge = {
    status: () => lastSnapshot,
    async reload() {
      const snapshot = await load();
      // Reapply relay context to newly created providers after reload
      if (currentRelayContext) {
        for (const provider of getOAuthProviders()) {
          provider.relayContext = currentRelayContext;
        }
      }
      return snapshot;
    },

    setRelayContext(ctx: RelayContext | null) {
      currentRelayContext = ctx;
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

  // Start MCP initialization eagerly — kick off server spawning and
  // handshakes immediately so they overlap with other extension factory
  // loading and relay connection setup.
  //
  // We do NOT await load() here, so the factory completes immediately and
  // other extension factories continue loading. Non-OAuth servers (stdio like
  // godmother) complete their handshake while other factories load.
  //
  // For OAuth streamable servers, defer the relay wait timeout window until
  // session_start so a long startup/registration path doesn't consume the
  // 15s fallback budget before the relay can publish context.
  setDeferOAuthRelayWaitTimeoutUntilAnchor(true);

  let eagerLoadPromise: Promise<McpSnapshot | null> | null = null;
  try {
    eagerLoadPromise = load().catch((err) => {
      // Don't crash the factory — session_start will handle diagnostics
      console.warn(`pizzapi: MCP eager init failed, will retry in session_start: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  } catch {
    // Swallow synchronous errors from load() setup
  }

  // ── session_start: await eager load + report timing to TUI/web UI ────────
  pi.on?.("session_start", async (_event: any, ctx: any) => {
    // Anchor relay wait timeout to session_start; any OAuth waiters created
    // during eager init begin their fallback window now.
    setDeferOAuthRelayWaitTimeoutUntilAnchor(false);
    markOAuthRelayWaitAnchorReady();

    try {
      if (eagerLoadPromise) {
        const result = await eagerLoadPromise;
        eagerLoadPromise = null;
        if (!result) {
          // Eager load failed — retry now that relay is connected
          await load();
        }
      } else {
        await load();
      }
    } catch {
      // Swallow — user can diagnose via /mcp.
    }

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
    description: "MCP status/reload/disable/enable: /mcp [reload|disable <name>|enable <name>]",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();

      // Sub-command completion for "disable <name>" and "enable <name>"
      if (normalized.startsWith("disable ") || normalized.startsWith("enable ")) {
        const isDisable = normalized.startsWith("disable ");
        const sub = isDisable ? normalized.slice(8) : normalized.slice(7);
        const disabledSet = new Set(lastSnapshot.config.disabledServers);
        const allServerNames = lastSnapshot.config.effectiveServers.map((s) => s.name);
        // For "disable": show servers that are NOT already disabled
        // For "enable": show servers that ARE disabled
        const pool = isDisable
          ? allServerNames.filter((n) => !disabledSet.has(n))
          : [...disabledSet];
        return pool
          .filter((n) => n.toLowerCase().startsWith(sub))
          .map((n) => ({
            value: `${isDisable ? "disable" : "enable"} ${n}`,
            label: n,
          }));
      }

      // Top-level sub-command completion
      const subcommands = ["reload", "disable", "enable"];
      const matches = subcommands.filter((c) => c.startsWith(normalized));
      return matches.length > 0
        ? matches.map((c) => ({ value: c, label: c }))
        : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim();
      const argLower = arg.toLowerCase();

      if (argLower === "reload") {
        ctx?.ui?.notify?.("Reloading MCP tools…");
        try {
          // Use bridge.reload() instead of load() directly so that relay
          // context is reapplied to freshly created OAuth providers. Calling
          // load() directly would leave providers in local-callback mode,
          // breaking web-based MCP OAuth for remote sessions.
          const snapshot = await bridge.reload();
          ctx?.ui?.notify?.(snapshot.lines.join("\n"));
          // Emit report so web UI can update
          const report = buildStartupReport();
          if (report) pi.events?.emit?.("mcp:startup_report", report);
        } catch (err) {
          ctx?.ui?.notify?.(`MCP reload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      if (argLower.startsWith("disable ")) {
        const serverName = arg.slice(8).trim();
        if (!serverName) {
          ctx?.ui?.notify?.("Usage: /mcp disable <server-name>", "warning");
          return;
        }
        const result = toggleMcpServer(serverName, true, process.cwd());
        if (!result.changed) {
          ctx?.ui?.notify?.(`Server "${serverName}" is already disabled.`);
          return;
        }
        ctx?.ui?.notify?.(`Disabled MCP server "${serverName}". Reloading…`);
        try {
          const snapshot = await bridge.reload();
          ctx?.ui?.notify?.(
            `✓ MCP server "${serverName}" disabled. ${snapshot.toolCount} tools loaded.\n` +
            `Use /mcp enable ${serverName} to re-enable.`,
          );
          const report = buildStartupReport();
          if (report) pi.events?.emit?.("mcp:startup_report", report);
        } catch (err) {
          ctx?.ui?.notify?.(`Config updated but MCP reload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      if (argLower.startsWith("enable ")) {
        const serverName = arg.slice(7).trim();
        if (!serverName) {
          ctx?.ui?.notify?.("Usage: /mcp enable <server-name>", "warning");
          return;
        }
        const result = toggleMcpServer(serverName, false, process.cwd());
        if (result.globallyDisabled) {
          ctx?.ui?.notify?.(
            `Cannot enable "${serverName}" — it is disabled in the global config (~/.pizzapi/config.json).\n` +
            `Remove it from disabledMcpServers in the global config to enable.`,
            "warning",
          );
          return;
        }
        if (!result.changed) {
          ctx?.ui?.notify?.(`Server "${serverName}" is already enabled.`);
          return;
        }
        ctx?.ui?.notify?.(`Enabled MCP server "${serverName}". Reloading…`);
        try {
          const snapshot = await bridge.reload();
          ctx?.ui?.notify?.(
            `✓ MCP server "${serverName}" enabled. ${snapshot.toolCount} tools loaded.`,
          );
          const report = buildStartupReport();
          if (report) pi.events?.emit?.("mcp:startup_report", report);
        } catch (err) {
          ctx?.ui?.notify?.(`Config updated but MCP reload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
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
