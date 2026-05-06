import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeProvider(homeDir: string, id: string): void {
  writeProviderSource(homeDir, id, `
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

function writeProviderSource(homeDir: string, id: string, source: string): void {
  const providerDir = join(homeDir, ".pizzapi", "providers", id);
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(join(providerDir, "index.ts"), source);
}

function makeCtx(cwd: string) {
  return {
    cwd,
    signal: new AbortController().signal,
    sessionManager: { getSessionFile: () => "test-session.json" },
  };
}

async function startProviderExtension(cwd: string) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown | Promise<unknown>>();
  const mockPi = {
    on(event: string, handler: (event: any, ctx: any) => unknown | Promise<unknown>) {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;

  const ext = await import("./extension");
  await ext.default(mockPi);
  await handlers.get("session_start")?.({ reason: "startup" }, makeCtx(cwd));
  return handlers;
}

describe("provider extension", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "provider-extension-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    (globalThis as any).__providerInitCalls = [];
    (globalThis as any).__providerExtensionCalls = [];
  });

  afterEach(() => {
    delete (globalThis as any).__providerInitCalls;
    delete (globalThis as any).__providerExtensionCalls;
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

  test("excludes providers whose init failed from bridge hooks", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "bad-init", initTrackingProviderSource("bad-init", "BAD", { failInit: true }));
    writeProviderSource(tmpHome, "good-init", initTrackingProviderSource("good-init", "GOOD"));

    const handlers = await startProviderExtension(cwd);

    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hello", images: [], systemPrompt: "line 1\nline 2\nline 3\nline 4" },
      makeCtx(cwd),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain("GOOD context");
    expect(result?.systemPrompt).not.toContain("BAD context");
    expect((globalThis as any).__providerExtensionCalls).toContain("good-init:start");
    expect((globalThis as any).__providerExtensionCalls).not.toContain("bad-init:start");

    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));
  });

  test("inserts prepended provider context after the system prompt preamble with delimiters", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "placement", placementProviderSource());
    const handlers = await startProviderExtension(cwd);

    const basePrompt = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hello", images: [], systemPrompt: basePrompt },
      makeCtx(cwd),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toStartWith(
      "line-1\nline-2\nline-3\n\n<!-- Provider Context -->\nPREPEND context\n<!-- End Provider Context -->\nline-4",
    );
    expect(result?.systemPrompt).toEndWith("\nAPPEND context\n");

    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));
  });

  test("resets provider dedupe state at each new prompt boundary", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "prompt-dedup", promptDedupProviderSource());
    const handlers = await startProviderExtension(cwd);

    const first = await handlers.get("before_agent_start")?.(
      { prompt: "first", images: [], systemPrompt: "line 1\nline 2\nline 3\nline 4" },
      makeCtx(cwd),
    ) as { systemPrompt?: string } | undefined;
    expect(first?.systemPrompt).toContain("Memory for first");

    const second = await handlers.get("before_agent_start")?.(
      { prompt: "second", images: [], systemPrompt: "line 1\nline 2\nline 3\nline 4" },
      makeCtx(cwd),
    ) as { systemPrompt?: string } | undefined;
    expect(second?.systemPrompt).toContain("Memory for second");
    expect(second?.systemPrompt).not.toContain("Memory for first");

    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));
  });
});

function initTrackingProviderSource(
  id: string,
  label: string,
  options: { failInit?: boolean } = {},
) {
  return `
export default {
  id: ${JSON.stringify(id)},
  capabilities: ["context", "lifecycle"],
  init() {
    const calls = globalThis.__providerExtensionCalls || [];
    calls.push(${JSON.stringify(`${id}:init`)});
    globalThis.__providerExtensionCalls = calls;
    ${options.failInit ? "throw new Error(\"init failed\");" : ""}
  },
  dispose() {},
  onBeforeAgentStart: async () => [
    { text: ${JSON.stringify(`${label} context`)}, placement: "prepend", order: 50, summary: ${JSON.stringify(label)}, dedupeKey: ${JSON.stringify(label)} },
  ],
  onSessionStart: async () => {
    const calls = globalThis.__providerExtensionCalls || [];
    calls.push(${JSON.stringify(`${id}:start`)});
    globalThis.__providerExtensionCalls = calls;
  },
};
`;
}

function placementProviderSource() {
  return `
export default {
  id: "placement",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async () => [
    { text: "PREPEND context", placement: "prepend", order: 50, summary: "Prepend" },
    { text: "APPEND context", placement: "append", order: 50, summary: "Append" },
  ],
};
`;
}

function promptDedupProviderSource() {
  return `
export default {
  id: "prompt-dedup",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async (event) => [
    { text: "Memory for " + event.prompt, placement: "prepend", order: 50, summary: "Prompt memory", dedupeKey: "same-key" },
  ],
};
`;
}
