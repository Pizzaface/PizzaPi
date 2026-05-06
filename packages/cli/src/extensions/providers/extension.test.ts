import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeProvider(homeDir: string, id: string): void {
  const providerDir = join(homeDir, ".pizzapi", "providers", id);
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(join(providerDir, "index.ts"), `
    export default {
      id: "${id}",
      capabilities: ["lifecycle"],
      init(ctx) {
        globalThis.__providerInitCalls = globalThis.__providerInitCalls || [];
        globalThis.__providerInitCalls.push({ id: "${id}", config: ctx.config });
      },
      dispose() {},
      onSessionStart: async () => {},
    };
  `);
}

describe("provider extension", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "provider-extension-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    (globalThis as any).__providerInitCalls = [];
  });

  afterEach(() => {
    delete (globalThis as any).__providerInitCalls;
    process.env.HOME = origHome;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  test("extension module exports a default function", async () => {
    const mod = await import("./extension");
    expect(typeof mod.default).toBe("function");
  });

  test("triggerSessionClose is exported", async () => {
    const mod = await import("./extension");
    expect(typeof mod.triggerSessionClose).toBe("function");
  });

  test("extension registers on session_start, before_agent_start, turn_end, session_shutdown", async () => {
    const events: string[] = [];
    const mockPi = {
      on: (event: string) => { events.push(event); },
      registerCommand: () => {},
    } as unknown as ExtensionAPI;

    const ext = await import("./extension");
    await ext.default(mockPi);

    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("turn_end");
    expect(events).toContain("session_shutdown");
  });

  test("skips disabled providers and passes per-provider config", async () => {
    const configDir = join(tmpHome, ".pizzapi");
    const cwd = join(tmpHome, "project");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      providers: {
        "enabled-provider": { customValue: "from-config" },
        "disabled-provider": { enabled: false, customValue: "skip-me" },
      },
    }));
    writeProvider(tmpHome, "enabled-provider");
    writeProvider(tmpHome, "disabled-provider");

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
    const mockPi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand: () => {},
    } as unknown as ExtensionAPI;

    const ext = await import("./extension");
    await ext.default(mockPi);
    await handlers.get("session_start")?.(
      { reason: "startup" },
      {
        cwd,
        signal: new AbortController().signal,
        sessionManager: { getSessionFile: () => "test-session.json" },
      },
    );

    expect((globalThis as any).__providerInitCalls).toEqual([
      { id: "enabled-provider", config: { customValue: "from-config" } },
    ]);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, { cwd, signal: new AbortController().signal });
  });
});
