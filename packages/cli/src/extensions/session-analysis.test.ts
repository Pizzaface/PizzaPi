import { afterEach, describe, expect, test } from "bun:test";
import {
  getSessionAnalysis,
  resetSessionAnalysis,
  sessionAnalysisExtension,
  sweepStaleSessionAnalysis,
} from "./session-analysis.js";

function createFakePi() {
  const handlers = new Map<string, Array<(event?: unknown) => void>>();
  return {
    api: {
      on(event: string, handler: (event?: unknown) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
    emit(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

describe("sessionAnalysisExtension", () => {
  const originalSessionId = process.env.PIZZAPI_SESSION_ID;

  afterEach(() => {
    if (originalSessionId == null) delete process.env.PIZZAPI_SESSION_ID;
    else process.env.PIZZAPI_SESSION_ID = originalSessionId;
    resetSessionAnalysis("test-session");
  });

  test("returns the SessionAnalysis shape consumed by the in-session panel", () => {
    process.env.PIZZAPI_SESSION_ID = "test-session";
    const fakePi = createFakePi();
    sessionAnalysisExtension(fakePi.api as any);

    fakePi.emit("session_start");
    fakePi.emit("turn_end", {
      turnIndex: 0,
      entryId: "assistant-1",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: {
          input: 1_000,
          output: 200,
          cacheRead: 250,
          cacheWrite: 50,
          totalTokens: 1_500,
          cost: { total: 0.01 },
        },
      },
    });

    const analysis = getSessionAnalysis("test-session");
    expect(analysis).not.toBeNull();
    expect(analysis?.sessionId).toBe("test-session");
    expect(analysis?.blocks).toHaveLength(1);
    expect(analysis?.blocks[0]).toMatchObject({
      entryId: "assistant-1",
      role: "turn",
      turnIndex: 0,
      tokens: 1_000,
      rawTokenDelta: 1_000,
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    });
    expect(analysis?.summary).toMatchObject({
      totalTokens: 1_500,
      totalCost: 0.01,
      peakContextUsage: 1_000,
    });
    expect(analysis?.modelsUsed[0]).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-20250514",
      turns: 1,
      totalCost: 0.01,
    });
    expect(analysis?.summary.estimatedCacheSavings).toBeCloseTo(0.000675);
  });

  test("TTL sweep removes stale sessions that missed shutdown", () => {
    process.env.PIZZAPI_SESSION_ID = "test-session";
    const fakePi = createFakePi();
    sessionAnalysisExtension(fakePi.api as any);

    fakePi.emit("session_start");
    fakePi.emit("turn_end", {
      turnIndex: 0,
      entryId: "assistant-1",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: { input: 1_000, output: 100, totalTokens: 1_100 },
      },
    });

    expect(getSessionAnalysis("test-session")).not.toBeNull();
    expect(sweepStaleSessionAnalysis(Date.now() + 25 * 60 * 60_000)).toBe(1);
    expect(getSessionAnalysis("test-session")).toBeNull();
  });

  test("live cache savings use model-specific pricing and become null for unknown pricing", () => {
    process.env.PIZZAPI_SESSION_ID = "test-session";
    const fakePi = createFakePi();
    sessionAnalysisExtension(fakePi.api as any);

    fakePi.emit("session_start");
    fakePi.emit("turn_end", {
      turnIndex: 0,
      entryId: "assistant-haiku",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 1_000,
          output: 100,
          cacheRead: 1_000,
          cacheWrite: 0,
          totalTokens: 2_100,
          cost: { total: 0.01 },
        },
      },
    });

    expect(getSessionAnalysis("test-session")?.summary.estimatedCacheSavings).toBeCloseTo(0.00072);

    fakePi.emit("turn_end", {
      turnIndex: 1,
      entryId: "assistant-unknown",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: {
          input: 1_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_100,
          cost: { total: 0.01 },
        },
      },
    });

    expect(getSessionAnalysis("test-session")?.summary.estimatedCacheSavings).toBeNull();
  });
});
