import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toggleMcpServer, loadConfig, _setGlobalConfigDir, resolveSandboxConfig, validateSandboxOverride, saveGlobalConfig, applyProviderSettingsEnv, isProjectMcpTrusted, type PizzaPiConfig } from "./config.js";

describe("toggleMcpServer", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pizzapi-config-test-"));
    globalDir = join(tempDir, "global-pizzapi");
    mkdirSync(globalDir, { recursive: true });
    // Override the global config dir for tests (Bun caches os.homedir())
    _setGlobalConfigDir(globalDir);
    // Write a minimal global config
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));
  });

  afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("disabling a server adds it to project config", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] } } }),
    );

    const result = toggleMcpServer("playwright", true, projectDir);
    expect(result.changed).toBe(true);
    expect(result.globallyDisabled).toBe(false);

    const updated = JSON.parse(readFileSync(join(projectDir, ".pizzapi", "config.json"), "utf-8"));
    expect(updated.disabledMcpServers).toContain("playwright");
    // Original config should be preserved
    expect(updated.mcpServers).toBeDefined();
  });

  test("enabling a disabled server removes it from project config", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright", "tavily"] }),
    );

    const result = toggleMcpServer("playwright", false, projectDir);
    expect(result.changed).toBe(true);
    expect(result.globallyDisabled).toBe(false);

    const updated = JSON.parse(readFileSync(join(projectDir, ".pizzapi", "config.json"), "utf-8"));
    expect(updated.disabledMcpServers).toEqual(["tavily"]);
  });

  test("enabling last disabled server removes the key entirely", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const result = toggleMcpServer("playwright", false, projectDir);
    expect(result.changed).toBe(true);

    const updated = JSON.parse(readFileSync(join(projectDir, ".pizzapi", "config.json"), "utf-8"));
    expect(updated.disabledMcpServers).toBeUndefined();
  });

  test("disabling an already disabled server returns changed: false", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const result = toggleMcpServer("playwright", true, projectDir);
    expect(result.changed).toBe(false);
  });

  test("enabling an already enabled server returns changed: false", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({}),
    );

    const result = toggleMcpServer("playwright", false, projectDir);
    expect(result.changed).toBe(false);
  });

  test("disabling a globally disabled server is a no-op (no sticky local entry)", () => {
    // Global config already disables "playwright"
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({}),
    );

    const result = toggleMcpServer("playwright", true, projectDir);
    expect(result.changed).toBe(false);
    expect(result.globallyDisabled).toBe(true);

    // Project config must NOT have a redundant disabledMcpServers entry
    const updated = JSON.parse(readFileSync(join(projectDir, ".pizzapi", "config.json"), "utf-8"));
    expect(updated.disabledMcpServers).toBeUndefined();
  });

  test("cannot enable a globally disabled server", () => {
    // Set the global config to disable "playwright"
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({}),
    );

    const result = toggleMcpServer("playwright", false, projectDir);
    expect(result.changed).toBe(false);
    expect(result.globallyDisabled).toBe(true);
  });

  test("creates .pizzapi dir if it does not exist", () => {
    const projectDir = join(tempDir, "newproject");
    mkdirSync(projectDir, { recursive: true });
    // No .pizzapi directory yet

    const result = toggleMcpServer("playwright", true, projectDir);
    expect(result.changed).toBe(true);

    const updated = JSON.parse(readFileSync(join(projectDir, ".pizzapi", "config.json"), "utf-8"));
    expect(updated.disabledMcpServers).toEqual(["playwright"]);
  });

  test("preserves other config fields when toggling", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcpServers: { playwright: { command: "npx" } },
        mcpTimeout: 5000,
      }),
    );

    toggleMcpServer("playwright", true, projectDir);

    const updated = JSON.parse(readFileSync(join(projectDir, ".pizzapi", "config.json"), "utf-8"));
    expect(updated.mcpServers).toBeDefined();
    expect(updated.mcpTimeout).toBe(5000);
    expect(updated.disabledMcpServers).toContain("playwright");
  });
});

describe("loadConfig disabledMcpServers merge", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pizzapi-config-merge-"));
    globalDir = join(tempDir, "global-pizzapi");
    mkdirSync(globalDir, { recursive: true });
    _setGlobalConfigDir(globalDir);
  });

  afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("merges global and project disabledMcpServers into a union", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ disabledMcpServers: ["tavily"] }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const config = loadConfig(projectDir);
    expect(config.disabledMcpServers).toBeDefined();
    expect(new Set(config.disabledMcpServers)).toEqual(new Set(["tavily", "playwright"]));
  });

  test("deduplicates overlapping entries", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ disabledMcpServers: ["tavily", "playwright"] }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const config = loadConfig(projectDir);
    expect(config.disabledMcpServers).toBeDefined();
    // Should have unique entries
    expect(config.disabledMcpServers!.length).toBe(2);
    expect(new Set(config.disabledMcpServers)).toEqual(new Set(["tavily", "playwright"]));
  });

  test("returns no disabledMcpServers when neither config has them", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({}),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({}),
    );

    const config = loadConfig(projectDir);
    expect(config.disabledMcpServers).toBeUndefined();
  });

  test("filters out non-string values", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ disabledMcpServers: ["tavily", 123, null, true] }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({}),
    );

    const config = loadConfig(projectDir);
    expect(config.disabledMcpServers).toEqual(["tavily"]);
  });

  test("only global disabled servers present", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ disabledMcpServers: ["tavily"] }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({}),
    );

    const config = loadConfig(projectDir);
    expect(config.disabledMcpServers).toEqual(["tavily"]);
  });

  test("only project disabled servers present", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({}),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ disabledMcpServers: ["playwright"] }),
    );

    const config = loadConfig(projectDir);
    expect(config.disabledMcpServers).toEqual(["playwright"]);
  });
});

describe("resolveSandboxConfig", () => {
  test("throws on invalid sandbox mode", () => {
    expect(() =>
      resolveSandboxConfig("/tmp", { sandbox: { mode: "ful" as any } } as any),
    ).toThrow(/Invalid sandbox mode "ful"/);
  });

  test("throws on empty string mode", () => {
    expect(() =>
      resolveSandboxConfig("/tmp", { sandbox: { mode: "" as any } } as any),
    ).toThrow(/Invalid sandbox mode ""/);
  });

  test("accepts valid mode 'none'", () => {
    const result = resolveSandboxConfig("/tmp", { sandbox: { mode: "none" } } as any);
    expect(result.mode).toBe("none");
    expect(result.srtConfig).toBeNull();
  });

  test("accepts valid mode 'basic'", () => {
    const result = resolveSandboxConfig("/tmp", { sandbox: { mode: "basic" } } as any);
    expect(result.mode).toBe("basic");
    expect(result.srtConfig).not.toBeNull();
  });

  test("accepts valid mode 'full'", () => {
    const result = resolveSandboxConfig("/tmp", { sandbox: { mode: "full" } } as any);
    expect(result.mode).toBe("full");
    expect(result.srtConfig).not.toBeNull();
    expect(result.srtConfig!.network).toBeDefined();
  });

  test("defaults to 'basic' when mode is omitted", () => {
    const result = resolveSandboxConfig("/tmp", { sandbox: {} } as any);
    expect(result.mode).toBe("basic");
  });

  test("coerces bare string allowWrite to array", () => {
    const result = resolveSandboxConfig("/tmp", {
      sandbox: { mode: "basic", filesystem: { allowWrite: "." as any } },
    } as any);
    expect(result.srtConfig).not.toBeNull();
    // Should not throw — the bare string "." is coerced to ["."]
    expect(result.srtConfig!.filesystem.allowWrite).toBeInstanceOf(Array);
    expect(result.srtConfig!.filesystem.allowWrite.length).toBeGreaterThan(0);
  });

  test("coerces bare string denyRead to array", () => {
    const result = resolveSandboxConfig("/tmp", {
      sandbox: { mode: "basic", filesystem: { denyRead: "/secret" as any } },
    } as any);
    // /secret should appear in denyRead (merged with preset defaults)
    expect(result.srtConfig!.filesystem.denyRead).toContain("/secret");
  });

  test("filters non-string items from array fields", () => {
    const result = resolveSandboxConfig("/tmp", {
      sandbox: {
        mode: "basic",
        filesystem: { denyWrite: [42, ".env", null, true] as any },
      },
    } as any);
    // Only the valid string ".env" should survive (plus preset defaults)
    const denyWrite = result.srtConfig!.filesystem.denyWrite;
    expect(denyWrite.every((v: unknown) => typeof v === "string")).toBe(true);
  });

  test("ignores non-array non-string allowWrite (falls back to preset)", () => {
    const result = resolveSandboxConfig("/tmp", {
      sandbox: { mode: "basic", filesystem: { allowWrite: true as any } },
    } as any);
    // Should fall back to preset default [".", "/tmp"]
    expect(result.srtConfig!.filesystem.allowWrite.length).toBe(2);
  });

  test("coerces network allowedDomains bare string in full mode", () => {
    const result = resolveSandboxConfig("/tmp", {
      sandbox: {
        mode: "full",
        network: { allowedDomains: "example.com" as any },
      },
    } as any);
    expect(result.srtConfig!.network!.allowedDomains).toEqual(["example.com"]);
  });
});

describe("validateSandboxOverride", () => {
  test("returns undefined for undefined/empty input", () => {
    expect(validateSandboxOverride(undefined)).toBeUndefined();
    expect(validateSandboxOverride("")).toBeUndefined();
  });

  test("resolves canonical mode names", () => {
    expect(validateSandboxOverride("none")).toBe("none");
    expect(validateSandboxOverride("basic")).toBe("basic");
    expect(validateSandboxOverride("full")).toBe("full");
  });

  test("resolves documented aliases", () => {
    expect(validateSandboxOverride("off")).toBe("none");
    expect(validateSandboxOverride("audit")).toBe("basic");
    expect(validateSandboxOverride("enforce")).toBe("full");
  });

  test("resolves case-insensitively", () => {
    expect(validateSandboxOverride("OFF")).toBe("none");
    expect(validateSandboxOverride("Full")).toBe("full");
    expect(validateSandboxOverride("ENFORCE")).toBe("full");
    expect(validateSandboxOverride("Basic")).toBe("basic");
  });

  test("throws on typos/unknown values", () => {
    expect(() => validateSandboxOverride("ful")).toThrow(/Invalid sandbox override "ful"/);
    expect(() => validateSandboxOverride("enabled")).toThrow(/Invalid sandbox override "enabled"/);
    expect(() => validateSandboxOverride("true")).toThrow(/Invalid sandbox override "true"/);
    expect(() => validateSandboxOverride("on")).toThrow(/Invalid sandbox override "on"/);
  });
});

// ── loadConfig mcpServers deep-merge ──────────────────────────────────────────

describe("loadConfig mcpServers deep-merge", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pizzapi-mcp-merge-"));
    globalDir = join(tempDir, "global-pizzapi");
    mkdirSync(globalDir, { recursive: true });
    _setGlobalConfigDir(globalDir);
  });

  afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("global-only mcpServers passes through", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({
        mcpServers: {
          godmother: { command: "godmother", args: ["serve"] },
          tavily: { command: "tavily-mcp" },
        },
      }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify({}));

    const config = loadConfig(projectDir) as any;
    expect(Object.keys(config.mcpServers)).toEqual(["godmother", "tavily"]);
    expect(config.mcpServers.godmother.command).toBe("godmother");
  });

  test("project-only mcpServers loads with warning (warn-and-load default)", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"] },
        },
      }),
    );

    const config = loadConfig(projectDir) as any;
    // Project MCP servers load by default (warning is emitted but loading is not blocked)
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.playwright.command).toBe("npx");
  });

  test("project-only mcpServers passes through when allowProjectMcp: true", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ allowProjectMcp: true }));

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"] },
        },
      }),
    );

    const config = loadConfig(projectDir) as any;
    expect(Object.keys(config.mcpServers)).toEqual(["playwright"]);
  });

  test("both defined: servers merge, project wins on name conflicts (requires allowProjectMcp)", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({
        allowProjectMcp: true,
        mcpServers: {
          godmother: { command: "godmother", args: ["serve"] },
          shared: { command: "global-version" },
        },
      }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"] },
          shared: { command: "project-version" },
        },
      }),
    );

    const config = loadConfig(projectDir) as any;
    // All three servers should be present
    expect(new Set(Object.keys(config.mcpServers))).toEqual(
      new Set(["godmother", "shared", "playwright"]),
    );
    // Global-only server preserved
    expect(config.mcpServers.godmother.command).toBe("godmother");
    // Project-only server present
    expect(config.mcpServers.playwright.command).toBe("npx");
    // Conflict: project wins
    expect(config.mcpServers.shared.command).toBe("project-version");
  });

  test("mcp.servers (preferred format) merges by server name (requires allowProjectMcp)", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({
        allowProjectMcp: true,
        mcp: {
          servers: [
            { name: "godmother", transport: "stdio", command: "godmother" },
            { name: "shared", transport: "stdio", command: "global-ver" },
          ],
        },
      }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcp: {
          servers: [
            { name: "playwright", transport: "stdio", command: "npx" },
            { name: "shared", transport: "stdio", command: "project-ver" },
          ],
        },
      }),
    );

    const config = loadConfig(projectDir) as any;
    const names = config.mcp.servers.map((s: any) => s.name);
    expect(new Set(names)).toEqual(new Set(["godmother", "shared", "playwright"]));
    const shared = config.mcp.servers.find((s: any) => s.name === "shared");
    expect(shared.command).toBe("project-ver");
  });

  test("one has mcpServers, other has mcp.servers — both formats load (requires allowProjectMcp)", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({
        allowProjectMcp: true,
        mcpServers: {
          godmother: { command: "godmother", args: ["serve"] },
        },
      }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcp: {
          servers: [
            { name: "playwright", transport: "stdio", command: "npx" },
          ],
        },
      }),
    );

    const config = loadConfig(projectDir) as any;
    // mcpServers from global
    expect(config.mcpServers.godmother.command).toBe("godmother");
    // mcp.servers from project (allowed because allowProjectMcp: true)
    expect(config.mcp.servers[0].name).toBe("playwright");
  });

  test("mcp.servers from project loads with warning (warn-and-load default)", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({
        mcpServers: {
          godmother: { command: "godmother", args: ["serve"] },
        },
      }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        mcp: {
          servers: [
            { name: "playwright", transport: "stdio", command: "npx" },
          ],
        },
      }),
    );

    const config = loadConfig(projectDir) as any;
    // mcpServers from global still loads
    expect(config.mcpServers.godmother.command).toBe("godmother");
    // mcp.servers from project also loads (warning is emitted but loading is not blocked)
    expect(config.mcp).toBeDefined();
    const names = config.mcp.servers.map((s: any) => s.name);
    expect(names).toContain("playwright");
  });

  test("project mcpServers allowed via PIZZAPI_ALLOW_PROJECT_MCP env var", () => {
    const orig = process.env.PIZZAPI_ALLOW_PROJECT_MCP;
    process.env.PIZZAPI_ALLOW_PROJECT_MCP = "1";
    try {
      writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));

      const projectDir = join(tempDir, "project");
      mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
      writeFileSync(
        join(projectDir, ".pizzapi", "config.json"),
        JSON.stringify({
          mcpServers: { playwright: { command: "npx" } },
        }),
      );

      const config = loadConfig(projectDir) as any;
      expect(config.mcpServers.playwright.command).toBe("npx");
    } finally {
      if (orig === undefined) delete process.env.PIZZAPI_ALLOW_PROJECT_MCP;
      else process.env.PIZZAPI_ALLOW_PROJECT_MCP = orig;
    }
  });

  test("neither config has mcpServers — no key added", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ apiKey: "test" }));

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify({}));

    const config = loadConfig(projectDir) as any;
    expect(config.mcpServers).toBeUndefined();
  });
});

// ── saveGlobalConfig ──────────────────────────────────────────────────────────

describe("saveGlobalConfig", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pizzapi-save-config-test-"));
    globalDir = join(tempDir, "global-pizzapi");
    mkdirSync(globalDir, { recursive: true });
    _setGlobalConfigDir(globalDir);
  });

  afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes valid JSON", () => {
    saveGlobalConfig({ apiKey: "test-key" });
    const raw = readFileSync(join(globalDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.apiKey).toBe("test-key");
  });

  test("creates config file if missing", () => {
    const freshDir = join(tempDir, "fresh-pizzapi");
    _setGlobalConfigDir(freshDir);
    saveGlobalConfig({ relayUrl: "ws://example.com" });
    const raw = readFileSync(join(freshDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.relayUrl).toBe("ws://example.com");
  });

  test("merges sandbox key without clobbering other config keys", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ apiKey: "keep-me", relayUrl: "ws://keep.com" }),
    );
    saveGlobalConfig({
      sandbox: {
        mode: "full",
        filesystem: { denyRead: ["~/.ssh"], allowWrite: [".", "/tmp"], denyWrite: [".env"] },
        network: { allowedDomains: ["*.github.com"], deniedDomains: [] },
      },
    });
    const parsed = JSON.parse(readFileSync(join(globalDir, "config.json"), "utf-8"));
    expect(parsed.apiKey).toBe("keep-me");
    expect(parsed.relayUrl).toBe("ws://keep.com");
    expect(parsed.sandbox.mode).toBe("full");
    expect(parsed.sandbox.filesystem.denyRead).toContain("~/.ssh");
  });

  test("round-trip: saveGlobalConfig → loadConfig produces expected merged result", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ apiKey: "original" }));
    saveGlobalConfig({
      sandbox: { mode: "basic", filesystem: { denyRead: ["~/custom"], allowWrite: ["."], denyWrite: [] } },
    });
    const config = loadConfig(tempDir);
    expect(config.apiKey).toBe("original");
    expect(config.sandbox?.mode).toBe("basic");
  });
});

// ---------------------------------------------------------------------------
// applyProviderSettingsEnv
// ---------------------------------------------------------------------------

describe("applyProviderSettingsEnv", () => {
  const envKeys = [
    "PIZZAPI_WEB_SEARCH",
    "PIZZAPI_WEB_SEARCH_MAX_USES",
    "PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS",
    "PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS",
  ];

  beforeEach(() => {
    for (const k of envKeys) delete process.env[k];
  });
  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
  });

  test("sets PIZZAPI_WEB_SEARCH when enabled", () => {
    applyProviderSettingsEnv({
      providerSettings: { anthropic: { webSearch: { enabled: true } } },
    } as PizzaPiConfig);
    expect(process.env.PIZZAPI_WEB_SEARCH).toBe("1");
  });

  test("does not set PIZZAPI_WEB_SEARCH when disabled/missing", () => {
    applyProviderSettingsEnv({} as PizzaPiConfig);
    expect(process.env.PIZZAPI_WEB_SEARCH).toBeUndefined();

    applyProviderSettingsEnv({
      providerSettings: { anthropic: { webSearch: { enabled: false } } },
    } as PizzaPiConfig);
    expect(process.env.PIZZAPI_WEB_SEARCH).toBeUndefined();
  });

  test("sets maxUses, allowedDomains, blockedDomains", () => {
    applyProviderSettingsEnv({
      providerSettings: {
        anthropic: {
          webSearch: {
            enabled: true,
            maxUses: 10,
            allowedDomains: ["a.com", "b.com"],
            blockedDomains: ["c.com"],
          },
        },
      },
    } as PizzaPiConfig);
    expect(process.env.PIZZAPI_WEB_SEARCH).toBe("1");
    expect(process.env.PIZZAPI_WEB_SEARCH_MAX_USES).toBe("10");
    expect(process.env.PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS).toBe("a.com,b.com");
    expect(process.env.PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS).toBe("c.com");
  });

  test("env vars take precedence over config", () => {
    process.env.PIZZAPI_WEB_SEARCH = "already-set";
    process.env.PIZZAPI_WEB_SEARCH_MAX_USES = "99";
    applyProviderSettingsEnv({
      providerSettings: {
        anthropic: {
          webSearch: { enabled: true, maxUses: 3 },
        },
      },
    } as PizzaPiConfig);
    // Should NOT overwrite
    expect(process.env.PIZZAPI_WEB_SEARCH).toBe("already-set");
    expect(process.env.PIZZAPI_WEB_SEARCH_MAX_USES).toBe("99");
  });
});

// ── isProjectMcpTrusted ───────────────────────────────────────────────────────

describe("isProjectMcpTrusted", () => {
  afterEach(() => {
    delete process.env.PIZZAPI_ALLOW_PROJECT_MCP;
  });

  test("returns false when allowProjectMcp is not set", () => {
    expect(isProjectMcpTrusted({})).toBe(false);
  });

  test("returns false when allowProjectMcp is false", () => {
    expect(isProjectMcpTrusted({ allowProjectMcp: false })).toBe(false);
  });

  test("returns true when allowProjectMcp is true", () => {
    expect(isProjectMcpTrusted({ allowProjectMcp: true })).toBe(true);
  });

  test("returns true when PIZZAPI_ALLOW_PROJECT_MCP=1", () => {
    process.env.PIZZAPI_ALLOW_PROJECT_MCP = "1";
    expect(isProjectMcpTrusted({})).toBe(true);
  });

  test("env var does not trust when set to other value", () => {
    process.env.PIZZAPI_ALLOW_PROJECT_MCP = "true";
    expect(isProjectMcpTrusted({})).toBe(false);
  });
});

// ── Transport field blocking ──────────────────────────────────────────────────

describe("loadConfig transport field blocking", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pizzapi-transport-test-"));
    globalDir = join(tempDir, "global-pizzapi");
    mkdirSync(globalDir, { recursive: true });
    _setGlobalConfigDir(globalDir);
  });

  afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("project apiKey loads with warning when global does not set apiKey", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ apiKey: "project-key" }),
    );

    const config = loadConfig(projectDir);
    // Project apiKey loads (warning is emitted) when global has no apiKey
    expect(config.apiKey).toBe("project-key");
  });

  test("project relayUrl loads with warning when global does not set relayUrl", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ relayUrl: "ws://project-relay.example.com" }),
    );

    const config = loadConfig(projectDir);
    // Project relayUrl loads (warning is emitted) when global has no relayUrl
    expect(config.relayUrl).toBe("ws://project-relay.example.com");
  });

  test("global apiKey is preserved when project also sets apiKey", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ apiKey: "real-global-key" }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ apiKey: "malicious-key" }),
    );

    const config = loadConfig(projectDir);
    expect(config.apiKey).toBe("real-global-key");
  });

  test("global relayUrl is preserved when project also sets relayUrl", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ relayUrl: "ws://my-real-relay.com" }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ relayUrl: "ws://attacker.example.com" }),
    );

    const config = loadConfig(projectDir);
    expect(config.relayUrl).toBe("ws://my-real-relay.com");
  });

  test("global apiKey is preserved when project does not set apiKey", () => {
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ apiKey: "global-key" }),
    );

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify({}));

    const config = loadConfig(projectDir);
    expect(config.apiKey).toBe("global-key");
  });

  test("non-transport project fields apply, project apiKey loads with warning", () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));

    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({ mcpTimeout: 9999, apiKey: "project-key" }),
    );

    const config = loadConfig(projectDir);
    expect(config.mcpTimeout).toBe(9999);
    // Project apiKey loads with a warning (not stripped) when global has no apiKey
    expect(config.apiKey).toBe("project-key");
  });
});
