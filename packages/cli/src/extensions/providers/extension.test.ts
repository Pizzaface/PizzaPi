import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

function lifecycleProviderSource(id: string, opts: { failDispose?: boolean; deferDispose?: boolean } = {}): string {
  const { failDispose = false, deferDispose = false } = opts;
  const deferBlock = deferDispose
    ? `
    return new Promise((resolve) => {
      globalThis.__disposeDeferred = globalThis.__disposeDeferred || {};
      globalThis.__disposeDeferred[${JSON.stringify(id)}] = resolve;
    });`
    : "";
  const failLine = failDispose ? `throw new Error(${JSON.stringify(`dispose failed: ${id}`)});` : "";
  // No lifecycle capability declared: these providers only exercise
  // init()/dispose() tracking, not bridge hooks, so an empty capabilities
  // array keeps loader validation happy without a throwaway hook method.
  return `
export default {
  id: ${JSON.stringify(id)},
  capabilities: [],
  init() {
    globalThis.__initCalls = globalThis.__initCalls || [];
    globalThis.__initCalls.push(${JSON.stringify(id)});
  },
  dispose() {
    globalThis.__disposeCalls = globalThis.__disposeCalls || [];
    globalThis.__disposeCalls.push(${JSON.stringify(id)});
    ${deferBlock}
    ${failLine}
  },
};
`;
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
    (globalThis as any).__initCalls = [];
    (globalThis as any).__disposeCalls = [];
    (globalThis as any).__disposeDeferred = {};
  });

  afterEach(() => {
    delete (globalThis as any).__providerInitCalls;
    delete (globalThis as any).__providerExtensionCalls;
    delete (globalThis as any).__initCalls;
    delete (globalThis as any).__disposeCalls;
    delete (globalThis as any).__disposeDeferred;
    process.env.HOME = origHome;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  test("extension module exports a default function", async () => {
    const mod = await import("./extension");
    expect(typeof mod.default).toBe("function");
  });

  test("runProviderSessionClose is exported", async () => {
    const mod = await import("./extension");
    expect(typeof mod.runProviderSessionClose).toBe("function");
  });

  test("runProviderSessionClose returns null with no bridge", async () => {
    const mod = await import("./extension");
    mod.__setBridgeForTest(null);
    expect(await mod.runProviderSessionClose("close")).toBeNull();
  });

  test("runProviderSessionClose invokes provider onSessionClose with reason, once", async () => {
    const mod = await import("./extension");
    const { ProviderBridge } = await import("../../providers/bridge");
    const calls: Array<{ reason: string }> = [];
    const provider = {
      id: "close-test",
      capabilities: ["lifecycle"],
      init: async () => {},
      dispose: () => {},
      onSessionClose: async (event: { reason: string }) => {
        calls.push({ reason: event.reason });
        return { label: "archived" };
      },
    };
    mod.__setBridgeForTest(new ProviderBridge([provider as any]));
    const first = await mod.runProviderSessionClose("complete");
    expect(first?.label).toBe("archived");
    expect(calls).toEqual([{ reason: "complete" }]);
    // Idempotent — second shutdown path must not re-run providers. It shares
    // the first call's cached result rather than running again or short-
    // circuiting to null (which would let a caller proceed to exit() before
    // the real close settled — see the concurrent-shutdown test below).
    const second = await mod.runProviderSessionClose("close");
    expect(second?.label).toBe("archived");
    expect(calls.length).toBe(1);
    mod.__setBridgeForTest(null);
  });

  test("runProviderSessionClose: concurrent callers await the same in-flight close", async () => {
    const mod = await import("./extension");
    const { ProviderBridge } = await import("../../providers/bridge");
    let resolveClose: ((v: { label: string }) => void) | undefined;
    let callCount = 0;
    const provider = {
      id: "slow-close",
      capabilities: ["lifecycle"],
      init: async () => {},
      dispose: () => {},
      onSessionClose: async () => {
        callCount++;
        return new Promise((resolve) => {
          resolveClose = resolve;
        });
      },
    };
    mod.__setBridgeForTest(new ProviderBridge([provider as any]));

    // First caller (e.g. a signal handler) starts the close but doesn't await
    // yet. A second caller (e.g. an extension-initiated shutdownHandler)
    // fires concurrently, before the provider's promise resolves.
    const firstCall = mod.runProviderSessionClose("close");
    await Promise.resolve(); // let the first call reach the in-flight provider promise
    const secondCall = mod.runProviderSessionClose("complete");

    // The second caller must NOT resolve early (e.g. to null) while the first
    // close is still in-flight — that's what let a shutdown path terminate a
    // real in-flight provider close.
    let secondResolved = false;
    secondCall.then(() => {
      secondResolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondResolved).toBe(false);

    resolveClose!({ label: "flushed" });
    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first?.label).toBe("flushed");
    expect(second?.label).toBe("flushed");
    expect(callCount).toBe(1);
    mod.__setBridgeForTest(null);
  });

  test("runProviderSessionClose bounds a hung provider via timeout", async () => {
    const mod = await import("./extension");
    const { ProviderBridge } = await import("../../providers/bridge");
    const provider = {
      id: "hung-provider",
      capabilities: ["lifecycle"],
      init: async () => {},
      dispose: () => {},
      onSessionClose: () => new Promise(() => {}),
    };
    mod.__setBridgeForTest(new ProviderBridge([provider as any]));
    const start = Date.now();
    const result = await mod.runProviderSessionClose("close", { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2000);
    mod.__setBridgeForTest(null);
  });

  test("runProviderSessionClose bounds N hung providers by one overall deadline, not N * timeoutMs", async () => {
    const mod = await import("./extension");
    const { ProviderBridge } = await import("../../providers/bridge");
    const hungProvider = (id: string) => ({
      id,
      capabilities: ["lifecycle"],
      init: async () => {},
      dispose: () => {},
      onSessionClose: () => new Promise(() => {}),
    });
    mod.__setBridgeForTest(
      new ProviderBridge([hungProvider("p1"), hungProvider("p2"), hungProvider("p3")] as any),
    );
    const start = Date.now();
    const result = await mod.runProviderSessionClose("close", { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Bridge runs providers sequentially. A per-provider (not overall)
    // timeout would let 3 hung providers add up to ~300ms; the shared
    // deadline should keep total time close to the single 100ms budget.
    expect(elapsed).toBeLessThan(250);
    mod.__setBridgeForTest(null);
  });

  test("runProviderSessionClose aborts its signal once the overall deadline elapses", async () => {
    const mod = await import("./extension");
    const { ProviderBridge } = await import("../../providers/bridge");
    let sawAbort = false;
    const provider = {
      id: "abort-aware",
      capabilities: ["lifecycle"],
      init: async () => {},
      dispose: () => {},
      onSessionClose: (_event: unknown, ctx: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve(null);
          });
        }),
    };
    mod.__setBridgeForTest(new ProviderBridge([provider as any]));
    await mod.runProviderSessionClose("close", { timeoutMs: 50 });
    expect(sawAbort).toBe(true);
    mod.__setBridgeForTest(null);
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

  test("forced onSessionShutdown rejection still disposes all providers and resets state", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "shutdown-a", lifecycleProviderSource("shutdown-a"));
    writeProviderSource(tmpHome, "shutdown-b", lifecycleProviderSource("shutdown-b"));
    const handlers = await startProviderExtension(cwd);

    const mod = await import("./extension");
    // ProviderBridge already swallows per-provider onSessionShutdown hook
    // errors internally, so to exercise the extension's own defensive catch
    // we swap in a bridge whose onSessionShutdown itself rejects.
    mod.__setBridgeForTest({
      onSessionShutdown: async () => {
        throw new Error("boom");
      },
    } as any);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));

    expect(((globalThis as any).__disposeCalls as string[]).sort()).toEqual(["shutdown-a", "shutdown-b"]);

    // bridge/providerInstances were reset despite the rejection.
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hi", images: [], systemPrompt: "line1\nline2\nline3\nline4" },
      makeCtx(cwd),
    );
    expect(result).toBeUndefined();
  });

  test("a later session initializes cleanly after a failed shutdown", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "shutdown-a", lifecycleProviderSource("shutdown-a"));
    const handlers = await startProviderExtension(cwd);

    const mod = await import("./extension");
    mod.__setBridgeForTest({
      onSessionShutdown: async () => {
        throw new Error("boom");
      },
    } as any);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));

    (globalThis as any).__initCalls = [];
    (globalThis as any).__disposeCalls = [];

    // Must not throw, and must not re-dispose an already-cleared instance
    // from the failed shutdown (session_start's defensive re-init loop runs
    // over providerInstances, which was already reset to []).
    await expect(
      handlers.get("session_start")?.({ reason: "startup" }, makeCtx(cwd)) as Promise<unknown>,
    ).resolves.toBeUndefined();

    expect((globalThis as any).__initCalls).toEqual(["shutdown-a"]);
    expect((globalThis as any).__disposeCalls).toEqual([]);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));
  });

  test("currentSessionInfo does not leak into a subsequent close after a failed shutdown", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "shutdown-a", lifecycleProviderSource("shutdown-a"));
    const handlers = await startProviderExtension(cwd);

    const mod = await import("./extension");
    const { ProviderBridge } = await import("../../providers/bridge");

    // Shutdown fails partway through — the claim/reset block must still
    // clear currentSessionInfo synchronously (before the first await) so a
    // subsequent close never sees this session's sessionFile/cwd.
    mod.__setBridgeForTest({
      onSessionShutdown: async () => {
        throw new Error("boom");
      },
    } as any);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));

    let seenCtx: { sessionFile?: string; cwd?: string } | undefined;
    mod.__setBridgeForTest(
      new ProviderBridge([
        {
          id: "close-after-shutdown",
          capabilities: ["lifecycle"],
          init: async () => {},
          dispose: () => {},
          onSessionClose: async (_event: unknown, ctx: any) => {
            seenCtx = { sessionFile: ctx.sessionFile, cwd: ctx.cwd };
            return null;
          },
        } as any,
      ]),
    );

    await mod.runProviderSessionClose("close");

    // makeCtx()'s sessionManager.getSessionFile() always returns
    // "test-session.json" and cwd is always the fixture project dir — if
    // currentSessionInfo had leaked, ctx would show those stale values here
    // instead of falling back to sessionId/process.cwd().
    expect(seenCtx?.sessionFile).not.toBe("test-session.json");
    expect(seenCtx?.cwd).not.toBe(cwd);

    mod.__setBridgeForTest(null);
  });

  test("concurrent session_shutdown events do not double-dispose the same provider instances", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "slow-dispose", lifecycleProviderSource("slow-dispose", { deferDispose: true }));
    const handlers = await startProviderExtension(cwd);

    const mod = await import("./extension");
    mod.__setBridgeForTest(null); // isolate dispose-claiming from bridge notification timing

    const first = handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd)) as Promise<unknown>;
    const second = handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd)) as Promise<unknown>;

    const resolveDispose = (globalThis as any).__disposeDeferred["slow-dispose"];
    expect(typeof resolveDispose).toBe("function");
    resolveDispose();

    await Promise.all([first, second]);

    expect((globalThis as any).__disposeCalls).toEqual(["slow-dispose"]);
  });

  test("if one provider's dispose rejects, remaining providers are still disposed and state resets", async () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(cwd, { recursive: true });
    writeProviderSource(tmpHome, "dispose-fail", lifecycleProviderSource("dispose-fail", { failDispose: true }));
    writeProviderSource(tmpHome, "dispose-ok", lifecycleProviderSource("dispose-ok"));
    const handlers = await startProviderExtension(cwd);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx(cwd));

    expect(((globalThis as any).__disposeCalls as string[]).sort()).toEqual(["dispose-fail", "dispose-ok"]);

    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hi", images: [], systemPrompt: "line1\nline2\nline3\nline4" },
      makeCtx(cwd),
    );
    expect(result).toBeUndefined();
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
