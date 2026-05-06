/**
 * E2E integration test for the provider pipeline.
 *
 * Validates the full lifecycle: discovery → loading → bridge → hooks → cleanup.
 * Uses a temp directory to mimic ~/.pizzapi/providers/ with real file-based
 * provider modules that are loaded via dynamic import.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProviders, globalProvidersDir } from "./loader";
import { ProviderBridge } from "./bridge";
import type { ExtensionProvider } from "./types";

// ── helpers ────────────────────────────────────────────────────

/** Create a minimal AbortSignal for passing to provider contexts. */
function signal() {
  return new AbortController().signal;
}

/** Shared context factory matching what the extension constructs. */
function ctx(overrides: Partial<import("./types").ProviderContext> = {}) {
  return {
    signal: signal(),
    timeoutMs: 5000,
    sessionId: "e2e-session",
    sessionFile: "/tmp/e2e-session.jsonl",
    cwd: "/tmp",
    promptId: "prompt-1",
    turnId: 0,
    isFirstTurn: true,
    ...overrides,
  };
}

// ── test suite ─────────────────────────────────────────────────

describe("Provider Pipeline E2E", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "provider-e2e-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    // Reset global call tracker
    (globalThis as any).__e2eCalls = [];
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── 1. Provider Discovery ────────────────────────────────────

  test("discovers a valid provider and reports zero errors", async () => {
    writeProvider("test-e2e", basicProviderSource());

    const result = await discoverProviders();

    expect(result.errors).toEqual([]);
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("test-e2e");
    expect(result.providers[0].source.origin).toBe("global");
  });

  test("reports an error for an invalid provider module", async () => {
    const providerDir = join(globalProvidersDir(), "bad-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `export default { notAProvider: true };`);

    const result = await discoverProviders();
    expect(result.providers).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // ── 2. Context Contributions & Sorting ───────────────────────

  test("onBeforeAgentStart returns context contributions sorted correctly", async () => {
    writeProvider("sort-test", sortingProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    const result = await bridge.onBeforeAgentStart(
      { prompt: "hello world", systemPrompt: "base" },
      ctx(),
    );

    // Provider returns:
    //   prepend order=50  → "A: prepend-order-50"
    //   prepend order=100 → "B: prepend-order-100"
    //   append  order=10  → "C: append-order-10"
    //
    // Sorted ascending:  C(10), A(50), B(100)
    // prepend reversed:   B, A   (higher order closer to top)
    // append kept:        C
    expect(result.prepend).toEqual([
      "B: prepend-order-100",
      "A: prepend-order-50",
    ]);
    expect(result.append).toEqual(["C: append-order-10"]);
    expect(result.summaries).toEqual([
      "B: prepend order 100",
      "A: prepend order 50",
      "C: append order 10",
    ]);
  });

  test("onBeforeAgentStart with empty contributions returns empty arrays", async () => {
    writeProvider("empty-test", emptyProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    const result = await bridge.onBeforeAgentStart(
      { prompt: "no match", systemPrompt: "base" },
      ctx(),
    );

    expect(result.prepend).toEqual([]);
    expect(result.append).toEqual([]);
    expect(result.summaries).toEqual([]);
  });

  // ── 3. Lifecycle Hooks ───────────────────────────────────────

  test("onTurnEnd fires lifecycle hook with correct event data", async () => {
    writeProvider("lifecycle-test", lifecycleProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    await bridge.onTurnEnd(
      {
        turnIndex: 3,
        message: { role: "assistant" as const, content: "All done!" },
        toolResults: [
          { name: "read", output: "file content", isError: false },
        ],
      },
      ctx({ turnId: 3, isFirstTurn: false }),
    );

    const calls: any[] = (globalThis as any).__e2eCalls;
    const turnCall = calls.find((c: any) => c.type === "turnEnd");
    expect(turnCall).toBeDefined();
    expect(turnCall.turnIndex).toBe(3);
  });

  test("onSessionClose returns the first non-null result", async () => {
    writeProvider("close-test", lifecycleProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    const result = await bridge.onSessionClose(
      { reason: "close", sessionFile: "/tmp/e2e-session.jsonl" },
      ctx(),
    );

    expect(result).toEqual({
      label: "Finalizing e2e",
      jobRef: { test: true },
    });
  });

  test("onSessionClose returns null when no provider returns a result", async () => {
    writeProvider("null-close-test", nullCloseProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    const result = await bridge.onSessionClose(
      { reason: "close", sessionFile: "/tmp/e2e-session.jsonl" },
      ctx(),
    );

    expect(result).toBeNull();
  });

  test("onSessionStart and onSessionShutdown fire without errors", async () => {
    writeProvider("lifecycle-test", lifecycleProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    await bridge.onSessionStart(
      { reason: "startup" },
      ctx({ promptId: undefined }),
    );
    await bridge.onSessionShutdown(
      { reason: "quit" },
      ctx({ promptId: undefined }),
    );

    // No errors thrown = pass
  });

  // ── 4. Error Isolation ───────────────────────────────────────

  test("isolates a failing provider so other providers still contribute", async () => {
    writeProvider("good-provider", basicProviderSource());
    writeProvider("bad-provider", failingProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    const result = await bridge.onBeforeAgentStart(
      { prompt: "hello", systemPrompt: "base" },
      ctx(),
    );

    // The good provider's contributions should still appear
    expect(result.prepend.length).toBeGreaterThan(0);
    expect(result.summaries.some((s) => s.includes("Pkg mgr"))).toBe(true);
  });

  test("disables a provider after MAX_CONSECUTIVE_ERRORS (3) failures", async () => {
    writeProvider("doomed", failingProviderSource());

    const { providers } = await discoverProviders();
    expect(providers.length).toBe(1);

    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    // Fire 3 times — provider should fail each time
    await bridge.onBeforeAgentStart(
      { prompt: "1", systemPrompt: "base" },
      ctx(),
    );
    expect(bridge.isDisabled("doomed")).toBe(false);

    await bridge.onBeforeAgentStart(
      { prompt: "2", systemPrompt: "base" },
      ctx(),
    );
    expect(bridge.isDisabled("doomed")).toBe(false);

    await bridge.onBeforeAgentStart(
      { prompt: "3", systemPrompt: "base" },
      ctx(),
    );
    // After 3 consecutive failures it should be disabled
    expect(bridge.isDisabled("bad-provider")).toBe(true);
  });

  test("error count resets on a successful call", async () => {
    writeProvider("flaky", flakyProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    // 2 failures (no-op prompts since provider only returns on "success")
    await bridge.onBeforeAgentStart(
      { prompt: "fail", systemPrompt: "base" },
      ctx(),
    );
    await bridge.onBeforeAgentStart(
      { prompt: "fail", systemPrompt: "base" },
      ctx(),
    );
    expect(bridge.isDisabled("flaky")).toBe(false);

    // 1 success resets error count
    await bridge.onBeforeAgentStart(
      { prompt: "success", systemPrompt: "base" },
      ctx(),
    );
    expect(bridge.isDisabled("flaky")).toBe(false);

    // 3 more failures — should now disable
    await bridge.onBeforeAgentStart(
      { prompt: "fail", systemPrompt: "base" },
      ctx(),
    );
    await bridge.onBeforeAgentStart(
      { prompt: "fail", systemPrompt: "base" },
      ctx(),
    );
    await bridge.onBeforeAgentStart(
      { prompt: "fail", systemPrompt: "base" },
      ctx(),
    );
    expect(bridge.isDisabled("flaky")).toBe(true);
  });

  // ── 5. Deduplication ─────────────────────────────────────────

  test("deduplicates onBeforeAgentStart contributions by dedupeKey across calls", async () => {
    writeProvider("dedup-test", dedupProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    // First call — "memory" in prompt triggers contribution with dedupeKey "pkg"
    const r1 = await bridge.onBeforeAgentStart(
      { prompt: "search memory", systemPrompt: "base" },
      ctx(),
    );

    expect(r1.summaries).toContain("Pkg mgr");
    const prependLen1 = r1.prepend.length;

    // Second call (same promptId, different turn) — same dedupeKey "pkg"
    // The bridge already stored dedupeKey "pkg" → returns the already-collected value
    const r2 = await bridge.onBeforeAgentStart(
      { prompt: "search memory again", systemPrompt: "base" },
      ctx({ turnId: 1, isFirstTurn: false }),
    );

    // prepend should have the same contributions (dedup prevented new ones)
    expect(r2.prepend.length).toBe(prependLen1);
    // The text should still be from the first call
    expect(r2.prepend).toEqual(r1.prepend);
  });

  // ── 6. Disabled provider test ────────────────────────────────

  test("disabled provider is skipped by bridge (verifies after 3 turn-end failures)", async () => {
    writeProvider("will-disable", failingOnTurnEndProviderSource());

    const { providers } = await discoverProviders();
    const bridge = new ProviderBridge(
      providers.map((p) => p.provider),
    );

    // 3 failures on onTurnEnd should disable "skip-me-2" (the failing provider's id)
    await bridge.onTurnEnd(
      { turnIndex: 0, message: { role: "assistant", content: "ok" } },
      ctx(),
    );
    await bridge.onTurnEnd(
      { turnIndex: 1, message: { role: "assistant", content: "ok" } },
      ctx(),
    );
    await bridge.onTurnEnd(
      { turnIndex: 2, message: { role: "assistant", content: "ok" } },
      ctx(),
    );

    expect(bridge.isDisabled("skip-me-2")).toBe(true);
  });
});

// ── Provider source factories ──────────────────────────────────

/** Writes a provider index.ts under tmpHome/.pizzapi/providers/<id>/ */
function writeProvider(id: string, source: string) {
  const dir = join(globalProvidersDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

/** Standard provider with context + lifecycle capabilities. */
function basicProviderSource() {
  return `
export default {
  id: "test-e2e",
  capabilities: ["context", "lifecycle"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async (event, ctx) => {
    if (event.prompt.includes("memory") || event.prompt.includes("hello")) {
      return [
        {
          text: "Memory: use pnpm",
          placement: "prepend",
          order: 50,
          summary: "Pkg mgr",
          dedupeKey: "pkg",
        },
        {
          text: "Directive: write tests",
          placement: "append",
          order: 100,
          summary: "Testing",
          dedupeKey: "test",
        },
        {
          text: "Tip: run typecheck",
          placement: "prepend",
          order: 75,
          summary: "Typecheck tip",
          dedupeKey: "tck",
        },
      ];
    }
    return [];
  },
  onTurnEnd: async (event, ctx) => {
    const calls = globalThis.__e2eCalls || [];
    calls.push({ type: "turnEnd", turnIndex: event.turnIndex });
    globalThis.__e2eCalls = calls;
  },
  onSessionClose: async (event, ctx) => ({
    label: "Finalizing e2e",
    jobRef: { test: true },
  }),
  onSessionStart: async (event, ctx) => {},
  onSessionShutdown: async (event, ctx) => {},
};
`;
}

/** Provider that returns contributions with explicit sort orders. */
function sortingProviderSource() {
  return `
export default {
  id: "sort-test",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async () => [
    { text: "A: prepend-order-50",  placement: "prepend", order: 50,  summary: "A: prepend order 50" },
    { text: "B: prepend-order-100", placement: "prepend", order: 100, summary: "B: prepend order 100" },
    { text: "C: append-order-10",   placement: "append",  order: 10,  summary: "C: append order 10" },
  ],
};
`;
}

/** Provider that returns no contributions. */
function emptyProviderSource() {
  return `
export default {
  id: "empty-test",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async () => [],
};
`;
}

/** Provider implementing all lifecycle hooks. */
function lifecycleProviderSource() {
  return `
export default {
  id: "lifecycle-test",
  capabilities: ["lifecycle"],
  init() {},
  dispose() {},
  onSessionStart: async (event, ctx) => {
    const calls = globalThis.__e2eCalls || [];
    calls.push({ type: "sessionStart", reason: event.reason });
    globalThis.__e2eCalls = calls;
  },
  onSessionShutdown: async (event, ctx) => {
    const calls = globalThis.__e2eCalls || [];
    calls.push({ type: "sessionShutdown", reason: event.reason });
    globalThis.__e2eCalls = calls;
  },
  onTurnEnd: async (event, ctx) => {
    const calls = globalThis.__e2eCalls || [];
    calls.push({ type: "turnEnd", turnIndex: event.turnIndex });
    globalThis.__e2eCalls = calls;
  },
  onSessionClose: async (event, ctx) => ({
    label: "Finalizing e2e",
    jobRef: { test: true },
  }),
};
`;
}

/** Provider whose onSessionClose returns null. */
function nullCloseProviderSource() {
  return `
export default {
  id: "null-close-test",
  capabilities: ["lifecycle"],
  init() {},
  dispose() {},
  onSessionClose: async () => null,
};
`;
}

/** Provider that always throws in onBeforeAgentStart. */
function failingProviderSource() {
  return `
export default {
  id: "bad-provider",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async () => {
    throw new Error("simulated provider failure");
  },
};
`;
}

/** Provider that throws on onTurnEnd (for testing disable via lifecycle errors). */
function failingOnTurnEndProviderSource() {
  return `
export default {
  id: "skip-me-2",
  capabilities: ["lifecycle"],
  init() {},
  dispose() {},
  onTurnEnd: async () => {
    throw new Error("turn end failure");
  },
};
`;
}

/** Flaky provider — fails unless prompt includes "success". */
function flakyProviderSource() {
  return `
export default {
  id: "flaky",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async (event) => {
    if (event.prompt.includes("success")) {
      return [{ text: "OK", placement: "prepend", order: 50, summary: "OK" }];
    }
    throw new Error("flaky failure");
  },
};
`;
}

/** Provider for testing dedup — returns fixed dedupeKey. */
function dedupProviderSource() {
  return `
export default {
  id: "dedup-test",
  capabilities: ["context"],
  init() {},
  dispose() {},
  onBeforeAgentStart: async (event) => {
    if (event.prompt.includes("memory")) {
      return [
        { text: "Memory: use pnpm", placement: "prepend", order: 50, summary: "Pkg mgr", dedupeKey: "pkg" },
        { text: "Directive: write tests", placement: "append", order: 100, summary: "Testing", dedupeKey: "test" },
      ];
    }
    return [];
  },
};
`;
}
