import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpStatusModel, decorateMcpSnapshotWithToolSearchState, inspectMcpConfig, reconcileMcpActiveTools, shouldLogMcpEagerInitFailure } from "./mcp-extension.js";
import { mergeOverlayMcpServers } from "./mcp-overlay.js";
import { runPackageCommand } from "../package-commands.js";
import { _setGlobalConfigDir } from "../config/io.js";

describe("shouldLogMcpEagerInitFailure", () => {
  test("suppresses expected pre-runtime and abort eager init failures", () => {
    expect(shouldLogMcpEagerInitFailure(new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."))).toBe(false);
    expect(shouldLogMcpEagerInitFailure(new Error("operation aborted"))).toBe(false);
  });

  test("keeps unexpected eager init failures visible", () => {
    expect(shouldLogMcpEagerInitFailure(new Error("stdio handshake failed"))).toBe(true);
    expect(shouldLogMcpEagerInitFailure("stdio handshake failed")).toBe(true);
  });
});

describe("buildMcpStatusModel", () => {
  test("classifies loaded, deferred, partial, and disabled MCP state", () => {
    const model = buildMcpStatusModel({
      effectiveServers: [
        { name: "github", transport: "http", scope: "global", keyPath: "mcpServers.github", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
        { name: "linear", transport: "http", scope: "global", keyPath: "mcpServers.linear", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
        { name: "figma", transport: "http", scope: "global", keyPath: "mcpServers.figma", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
      ],
      disabledServers: ["figma"],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
        linear: ["mcp_linear_search"],
      },
      toolSearch: {
        active: true,
        deferredTools: [
          {
            name: "mcp_github_create_pr",
            description: "Create a PR",
            parameterNames: ["title"],
            charCount: 100,
            serverName: "github",
          },
          {
            name: "mcp_linear_search",
            description: "Search Linear",
            parameterNames: ["query"],
            charCount: 100,
            serverName: "linear",
          },
        ],
        loadedOnDemandTools: [],
      },
    });

    expect(model.counts).toEqual({
      totalTools: 3,
      loadedTools: 1,
      deferredTools: 2,
      loadedOnDemandTools: 0,
      disabledServers: 1,
    });

    expect(model.serverStates).toHaveLength(3);
    expect(model.serverStates).toContainEqual(
      expect.objectContaining({ name: "figma", state: "disabled" }),
    );
    expect(model.serverStates).toContainEqual(
      expect.objectContaining({ name: "github", state: "partial", loadedToolCount: 1, deferredToolCount: 1 }),
    );
    expect(model.serverStates).toContainEqual(
      expect.objectContaining({ name: "linear", state: "deferred", loadedToolCount: 0, deferredToolCount: 1 }),
    );

    expect(model.toolStates).toEqual([
      expect.objectContaining({ name: "mcp_github_create_issue", serverName: "github", state: "loaded" }),
      expect.objectContaining({ name: "mcp_github_create_pr", serverName: "github", state: "deferred" }),
      expect.objectContaining({ name: "mcp_linear_search", serverName: "linear", state: "deferred" }),
    ]);
  });

  test("marks loaded-on-demand tools distinctly from always-loaded tools", () => {
    const model = buildMcpStatusModel({
      effectiveServers: [
        { name: "github", transport: "http", scope: "global", keyPath: "mcpServers.github", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
      ],
      disabledServers: [],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
      },
      toolSearch: {
        active: true,
        deferredTools: [
          {
            name: "mcp_github_create_pr",
            description: "Create a PR",
            parameterNames: ["title"],
            charCount: 100,
            serverName: "github",
          },
        ],
        loadedOnDemandTools: [
          {
            name: "mcp_github_create_issue",
            description: "Create issue",
            parameterNames: ["title"],
            charCount: 100,
            serverName: "github",
          },
        ],
      },
    });

    expect(model.counts).toEqual({
      totalTools: 2,
      loadedTools: 0,
      deferredTools: 1,
      loadedOnDemandTools: 1,
      disabledServers: 0,
    });
    expect(model.serverStates).toEqual([
      expect.objectContaining({ name: "github", state: "partial", loadedToolCount: 0, deferredToolCount: 1, loadedOnDemandToolCount: 1 }),
    ]);
    expect(model.toolStates).toEqual([
      expect.objectContaining({ name: "mcp_github_create_issue", state: "loaded_on_demand" }),
      expect.objectContaining({ name: "mcp_github_create_pr", state: "deferred" }),
    ]);
  });

  test("reconcileMcpActiveTools does not re-activate tools that are still deferred after reload", () => {
    const result = reconcileMcpActiveTools({
      currentActive: ["search_tools"],
      previousMcpToolNames: ["mcp_github_create_issue"],
      newMcpToolNames: ["mcp_github_create_issue", "mcp_github_create_pr"],
      deferredToolNames: ["mcp_github_create_pr"],
    });

    expect(result).toContain("search_tools");
    expect(result).toContain("mcp_github_create_issue");
    expect(result).not.toContain("mcp_github_create_pr");
  });

  test("decorates cached snapshots with current tool-search state", () => {
    const decorated = decorateMcpSnapshotWithToolSearchState({
      toolCount: 2,
      toolNames: ["mcp_github_create_issue", "mcp_github_create_pr"],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
      },
      errors: [],
      loadedAt: "2026-04-28T20:00:00.000Z",
      config: {
        global: { scope: "global", path: "~/.pizzapi/config.json", exists: true, hasMcpKey: false, hasMcpServersKey: true, preferredServers: [], compatibilityServers: [] },
        project: { scope: "project", path: ".pizzapi/config.json", exists: false, hasMcpKey: false, hasMcpServersKey: false, preferredServers: [], compatibilityServers: [] },
        effectivePreferredSource: "none",
        effectiveCompatibilitySource: "global",
        effectiveServers: [
          { name: "github", transport: "http", scope: "global", keyPath: "mcpServers.github", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
        ],
        disabledServers: [],
      },
      summary: "stale",
      lines: ["stale"],
      serverStates: [],
      toolStates: [],
      counts: {
        totalTools: 0,
        loadedTools: 0,
        deferredTools: 0,
        loadedOnDemandTools: 0,
        disabledServers: 0,
      },
      serverTimings: [],
      totalDurationMs: 0,
    } as any, {
      active: true,
      deferredTools: [
        {
          name: "mcp_github_create_pr",
          description: "Create a PR",
          parameterNames: ["title"],
          charCount: 100,
          serverName: "github",
        },
      ],
      loadedOnDemandTools: [
        {
          name: "mcp_github_create_issue",
          description: "Create issue",
          parameterNames: ["title"],
          charCount: 100,
          serverName: "github",
        },
      ],
    });

    expect(decorated.summary).toContain("1 loaded on-demand");
    expect(decorated.summary).toContain("1 deferred");
    expect(decorated.lines[0]).toContain("1 loaded on-demand");
    expect(decorated.lines[0]).toContain("1 deferred");
    expect(decorated.toolStates).toEqual([
      expect.objectContaining({ name: "mcp_github_create_issue", state: "loaded_on_demand" }),
      expect.objectContaining({ name: "mcp_github_create_pr", state: "deferred" }),
    ]);
  });
});

// ── P1.4: /mcp status + disable/enable completion must see overlay-origin servers ──
//
// mcp-extension.ts's load() feeds mergeOverlayMcpServers()'s `serverProvenance`
// into inspectMcpConfig() so the SAME merge that produces the live MCP
// registry also produces what `/mcp` status renders and what disable/enable
// tab-completion offers (lastSnapshot.config.effectiveServers). This
// exercises that real wiring end-to-end (real package install, real merge,
// real inspection) rather than asserting on either half in isolation.
describe("inspectMcpConfig — overlay/legacy server provenance (real mergeOverlayMcpServers wiring)", () => {
  let tmpDir: string;
  let cwd: string;
  let agentDir: string;
  let originalCwd: string;
  let originalAgentDirEnv: string | undefined;

  beforeEach(() => {
    // runPackageCommand() chdir()s into cwd and only sets
    // PI_CODING_AGENT_DIR when unset — both must be restored so later test
    // files in this same bun test process don't inherit a deleted tmp cwd
    // or a stale agentDir (see other overlay tests' identical notes).
    originalCwd = process.cwd();
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-mcpext-overlay-"));
    cwd = join(tmpDir, "project");
    agentDir = join(tmpDir, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    _setGlobalConfigDir(join(tmpDir, "global-config"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    _setGlobalConfigDir(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a package-overlay MCP server appears in effectiveServers with 'user-package' scope, feeding /mcp status and disable/enable completion", async () => {
    const pkgDir = join(tmpDir, "status-mcp-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "status-mcp-pkg", pi: { pizzapi: { schemaVersion: 1, mcp: "./.mcp.json" } } }));
    writeFileSync(join(pkgDir, ".mcp.json"), JSON.stringify({ mcpServers: { fromOverlayStatus: { command: "echo" } } }));
    const code = await runPackageCommand(["install", "../status-mcp-pkg"], cwd, agentDir);
    expect(code).toBe(0);

    const { serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, true);
    const inspection = inspectMcpConfig(cwd, serverProvenance);

    const entry = inspection.effectiveServers.find((s) => s.name === "fromOverlayStatus");
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe("user-package");
    expect(entry?.transport).toBe("stdio");

    // Disable/enable tab-completion (mcp-extension.ts's getArgumentCompletions)
    // pools names straight from effectiveServers — assert the same source
    // list a package-origin server needs to be present in to be toggleable.
    const allServerNames = inspection.effectiveServers.map((s) => s.name);
    expect(allServerNames).toContain("fromOverlayStatus");
  });

  test("an explicit config-file server is NOT duplicated into overlay provenance (config always wins, never double-listed)", async () => {
    const pkgDir = join(tmpDir, "collide-mcp-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "collide-mcp-pkg", pi: { pizzapi: { schemaVersion: 1, mcp: "./.mcp.json" } } }));
    writeFileSync(join(pkgDir, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "pkg-cmd" } } }));
    const code = await runPackageCommand(["install", "../collide-mcp-pkg"], cwd, agentDir);
    expect(code).toBe(0);

    mkdirSync(join(cwd, ".pizzapi"), { recursive: true });
    writeFileSync(join(cwd, ".pizzapi", "config.json"), JSON.stringify({ mcpServers: { shared: { command: "explicit-cmd" } } }));

    const base = { mcpServers: { shared: { command: "explicit-cmd" } } };
    const { serverProvenance } = mergeOverlayMcpServers(base, cwd, agentDir, true);
    const inspection = inspectMcpConfig(cwd, serverProvenance);

    const sharedEntries = inspection.effectiveServers.filter((s) => s.name === "shared");
    expect(sharedEntries).toHaveLength(1);
    expect(sharedEntries[0]?.scope).toBe("project"); // from the explicit .pizzapi/config.json, not the package overlay
  });
});
