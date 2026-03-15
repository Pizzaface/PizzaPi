import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toggleMcpServer, loadConfig, _setGlobalConfigDir, resolveSandboxConfig } from "./config.js";

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
});
