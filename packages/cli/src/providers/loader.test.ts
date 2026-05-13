import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProviders, globalProvidersDir } from "./loader";
import type { ExtensionProvider, ProviderInitContext } from "./types";

describe("discoverProviders", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-loader-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty when no providers directory exists", async () => {
    const result = await discoverProviders();
    expect(result.providers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("discovers a single provider from global directory", async () => {
    const providerDir = join(globalProvidersDir(), "test-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default {
        id: "test-provider",
        capabilities: ["context"],
        init() {},
        dispose() {},
        onBeforeAgentStart: async () => [],
      };
    `);

    const result = await discoverProviders();
    expect(result.errors).toEqual([]);
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("test-provider");
  });

  test("discovers from project-local directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "project-"));
    const providerDir = join(projectDir, ".pizzapi", "providers", "local-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default {
        id: "local-provider",
        capabilities: ["lifecycle"],
        init() {},
        dispose() {},
        onSessionStart: async () => {},
      };
    `);

    const result = await discoverProviders({ cwd: projectDir, allowProject: true });
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("local-provider");
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("skips project providers when allowProject is false", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "project-skip-"));
    const providerDir = join(projectDir, ".pizzapi", "providers", "skip-me");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default { id: "skip-me", capabilities: ["context"], init() {}, dispose() {}, onBeforeAgentStart: async () => [] };
    `);

    const result = await discoverProviders({ cwd: projectDir, allowProject: false });
    expect(result.providers).toEqual([]);
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("reports error for invalid provider module", async () => {
    const providerDir = join(globalProvidersDir(), "bad-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default { notAProvider: true };
    `);

    const result = await discoverProviders();
    expect(result.providers).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("deduplicates by provider ID (global wins over project)", async () => {
    const globalDir = join(globalProvidersDir(), "dup-provider");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "index.ts"), `
      export default { id: "dup-provider", capabilities: ["context"], init() {}, dispose() {}, onBeforeAgentStart: async () => [] };
    `);

    const projectDir = mkdtempSync(join(tmpdir(), "project-dup-"));
    const localDir = join(projectDir, ".pizzapi", "providers", "dup-provider");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "index.ts"), `
      export default { id: "dup-provider", capabilities: ["lifecycle"], init() {}, dispose() {}, onSessionStart: async () => {} };
    `);

    const result = await discoverProviders({ cwd: projectDir, allowProject: true });
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.capabilities).toContain("context");
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("provider with only onSessionShutdown is accepted as lifecycle", async () => {
    const providerDir = join(globalProvidersDir(), "shutdown-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default {
        id: "shutdown-provider",
        capabilities: ["lifecycle"],
        init() {},
        dispose() {},
        onSessionShutdown: async () => {},
      };
    `);

    const result = await discoverProviders();
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("shutdown-provider");
  });
});
