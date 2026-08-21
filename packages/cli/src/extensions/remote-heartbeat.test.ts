import { describe, test, expect } from "bun:test";
import { buildTokenUsage } from "./remote-heartbeat.js";

function entry(input: number, output: number) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
  };
}

function makeRctx(entries: any[], leafId: string, contextTokens: number) {
  const manager = {
    getEntries: () => entries,
    getLeafId: () => leafId,
  };
  const rctx: any = {
    latestCtx: {
      sessionManager: manager,
      getContextUsage: () => ({ tokens: contextTokens }),
    },
  };
  return rctx;
}

describe("buildTokenUsage", () => {
  test("two sessions with identical entry count and leafId do not share totals", () => {
    const a = makeRctx([entry(100, 50)], "leaf-1", 1000);
    const b = makeRctx([entry(999, 999)], "leaf-1", 2000);

    // Prime a's cache, then read b — b must NOT get a's totals.
    expect(buildTokenUsage(a).input).toBe(100);
    expect(buildTokenUsage(b).input).toBe(999);
    // And a is still correct afterwards.
    expect(buildTokenUsage(a).input).toBe(100);
  });

  test("session switch (new manager, same entry count/leafId) recomputes totals", () => {
    const rctx = makeRctx([entry(100, 50)], "leaf-1", 1000);
    expect(buildTokenUsage(rctx).input).toBe(100);

    // Swap the session manager under the same rctx (e.g. /new) — same entry
    // count and leafId, different data.
    rctx.latestCtx.sessionManager = {
      getEntries: () => [entry(7, 3)],
      getLeafId: () => "leaf-1",
    };
    expect(buildTokenUsage(rctx).input).toBe(7);
  });

  test("compaction with unchanged entry count/leafId still refreshes contextTokens", () => {
    let tokens = 50_000;
    const rctx = makeRctx([entry(100, 50)], "leaf-1", 0);
    rctx.latestCtx.getContextUsage = () => ({ tokens });

    expect(buildTokenUsage(rctx).contextTokens).toBe(50_000);
    // Compaction shrinks context without changing the cache key.
    tokens = 5_000;
    expect(buildTokenUsage(rctx).contextTokens).toBe(5_000);
  });

  test("returns zeros with no latestCtx", () => {
    const result = buildTokenUsage({ latestCtx: null } as any);
    expect(result).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: null });
  });
});
