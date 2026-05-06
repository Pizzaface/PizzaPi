import { describe, test, expect } from "bun:test";
import { ProviderBridge } from "./bridge";
import type { ExtensionProvider } from "./types";

function makeProvider(overrides: Record<string, any> = {}): ExtensionProvider {
  return {
    id: "test",
    capabilities: ["context", "lifecycle"] as const,
    init() {},
    dispose() {},
    ...overrides,
  } as ExtensionProvider;
}

describe("ProviderBridge", () => {
  test("collects and separates prepend/append contributions", async () => {
    const provider = makeProvider({
      onBeforeAgentStart: async () => [
        { text: "A-prepend", placement: "prepend", order: 100, summary: "A" },
        { text: "B-append", placement: "append", order: 50, summary: "B" },
      ],
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    const result = await bridge.onBeforeAgentStart({ prompt: "hello", systemPrompt: "base" }, ctx);
    expect(result.prepend).toEqual(["A-prepend"]);
    expect(result.append).toEqual(["B-append"]);
    expect(result.summaries).toEqual(["A", "B"]);
  });

  test("sorts by order ascending, then providerId (prepend: higher order closer to top)", async () => {
    const a = makeProvider({
      id: "alpha",
      onBeforeAgentStart: async () => [
        { text: "A-100", placement: "prepend", order: 100, summary: "A" },
      ],
    });
    const b = makeProvider({
      id: "beta",
      onBeforeAgentStart: async () => [
        { text: "B-50", placement: "prepend", order: 50, summary: "B" },
      ],
    });

    const bridge = new ProviderBridge([a, b]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    const result = await bridge.onBeforeAgentStart({ prompt: "h", systemPrompt: "base" }, ctx);
    // Sorted ascending by order: 50, 100 → prepended in order → higher order closer to top
    expect(result.prepend).toEqual(["A-100", "B-50"]);
  });

  test("deduplicates by providerId + dedupeKey across calls", async () => {
    let callCount = 0;
    let returnedKey = "key1";
    const provider = makeProvider({
      onBeforeAgentStart: async () => {
        callCount++;
        return [
          { text: `Call ${callCount}`, placement: "prepend", order: 50, summary: "T", dedupeKey: returnedKey },
        ];
      },
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    // First call
    const r1 = await bridge.onBeforeAgentStart({ prompt: "a", systemPrompt: "base" }, ctx);
    expect(r1.prepend).toEqual(["Call 1"]);

    // Same key — should retain first value (dedup)
    const r2 = await bridge.onBeforeAgentStart({ prompt: "b", systemPrompt: "base" }, ctx);
    expect(r2.prepend).toEqual(["Call 1"]);

    // Different key — new value
    returnedKey = "key2";
    const r3 = await bridge.onBeforeAgentStart({ prompt: "c", systemPrompt: "base" }, ctx);
    expect(r3.prepend).toEqual(["Call 1", "Call 3"]);
  });

  test("isolates failing providers", async () => {
    const good = makeProvider({
      id: "good",
      onBeforeAgentStart: async () => [{ text: "Good", placement: "prepend", order: 50, summary: "G" }],
    });
    const bad = makeProvider({
      id: "bad",
      onBeforeAgentStart: async () => { throw new Error("boom"); },
    });

    const bridge = new ProviderBridge([good, bad]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    const result = await bridge.onBeforeAgentStart({ prompt: "hello", systemPrompt: "base" }, ctx);
    expect(result.prepend).toEqual(["Good"]);
  });

  test("disables provider after 3 consecutive errors", async () => {
    const bad = makeProvider({
      id: "bad",
      onBeforeAgentStart: async () => { throw new Error("boom"); },
    });

    const bridge = new ProviderBridge([bad]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    await bridge.onBeforeAgentStart({ prompt: "1", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "2", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "3", systemPrompt: "base" }, ctx);

    expect(bridge.isDisabled("bad")).toBe(true);
  });

  test("resets error count on success", async () => {
    let shouldFail = true;
    const provider = makeProvider({
      id: "flaky",
      onBeforeAgentStart: async () => {
        if (shouldFail) throw new Error("boom");
        return [{ text: "OK", placement: "prepend", order: 50, summary: "OK" }];
      },
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    // 2 fails, then 1 success, then 3 fails — should not disable until 3 consecutive
    await bridge.onBeforeAgentStart({ prompt: "1", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "2", systemPrompt: "base" }, ctx);
    expect(bridge.isDisabled("flaky")).toBe(false);

    shouldFail = false;
    await bridge.onBeforeAgentStart({ prompt: "3", systemPrompt: "base" }, ctx);
    expect(bridge.isDisabled("flaky")).toBe(false);

    shouldFail = true;
    await bridge.onBeforeAgentStart({ prompt: "4", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "5", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "6", systemPrompt: "base" }, ctx);
    expect(bridge.isDisabled("flaky")).toBe(true);
  });

  test("calls lifecycle hooks", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      id: "lifecycle",
      capabilities: ["lifecycle"] as const,
      onTurnEnd: async (event: { turnIndex: number }) => { calls.push(`turn-${event.turnIndex}`); },
      onSessionStart: async (event: { reason: string }) => { calls.push(`start-${event.reason}`); },
      onSessionShutdown: async (event: { reason: string }) => { calls.push(`shutdown-${event.reason}`); },
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp" };

    await bridge.onSessionStart({ reason: "startup" }, ctx);
    await bridge.onTurnEnd({ turnIndex: 1, message: { role: "assistant", content: "ok" } }, { ...ctx, promptId: "p1", turnId: 1 });
    await bridge.onSessionShutdown({ reason: "quit" }, ctx);

    expect(calls).toEqual(["start-startup", "turn-1", "shutdown-quit"]);
  });

  test("onSessionClose returns first non-null result", async () => {
    const a = makeProvider({
      id: "alpha",
      capabilities: ["lifecycle"] as const,
      onSessionClose: async () => null,
    });
    const b = makeProvider({
      id: "beta",
      capabilities: ["lifecycle"] as const,
      onSessionClose: async () => ({ label: "Flushing beta", jobRef: { id: "j1" } }),
    });

    const bridge = new ProviderBridge([a, b]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp" };

    const result = await bridge.onSessionClose({ reason: "close", sessionFile: "/tmp/s.jsonl" }, ctx);
    expect(result).toEqual({ label: "Flushing beta", jobRef: { id: "j1" } });
  });
});
