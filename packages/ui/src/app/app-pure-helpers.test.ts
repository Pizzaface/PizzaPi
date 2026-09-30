/**
 * Unit tests for the small pure helpers extracted from App.tsx:
 * session cache entries, MCP startup report text, plan parsing, sidebar /
 * badge derivations, stale thresholds and model grouping.
 */
import { describe, expect, test } from "bun:test";
import type { HubSession } from "@/components/SessionSidebar";
import type { SessionUiCacheEntry } from "@/lib/types";
import { buildSessionCacheEntry, patchTouchesAwaitingInput, withSetMember } from "./session-cache-entry";
import { formatMcpStartupReport } from "./mcp-startup-report";
import { normalizeMetaPendingPlan, parsePlanModeSource } from "./pending-plan";
import { pruneToLiveSessions } from "./useLiveSessionBadges";
import { deriveSidebarRunners, sidebarRunnersCacheKey } from "./useSidebarRunners";
import { getStaleThresholdMs, HEARTBEAT_INTERVAL_MS, makeExecId } from "./constants";
import { groupVisibleModels } from "./model-groups";

describe("buildSessionCacheEntry", () => {
  test("fills every field with defaults when there is no previous entry", () => {
    const entry = buildSessionCacheEntry(undefined, {}, 123);
    expect(entry).toEqual({
      snapshotMessages: undefined,
      messages: [],
      activeModel: null,
      sessionName: null,
      availableModels: [],
      availableCommands: [],
      agentActive: false,
      isCompacting: false,
      effortLevel: null,
      planModeEnabled: false,
      authSource: null,
      tokenUsage: null,
      providerUsage: null,
      lastHeartbeatAt: null,
      todoList: [],
      messageQueue: [],
      analysis: null,
      pendingQuestion: null,
      pendingPlan: null,
      goal: null,
      lastAccessed: 123,
    });
  });

  test("keeps previous fields and applies the patch on top", () => {
    const prev = buildSessionCacheEntry(undefined, { sessionName: "old", agentActive: true }, 1);
    const next = buildSessionCacheEntry(prev, { sessionName: "new" }, 2);
    expect(next.sessionName).toBe("new");
    expect(next.agentActive).toBe(true);
  });

  test("always stamps lastAccessed with now, even if the patch sets it", () => {
    const next = buildSessionCacheEntry(undefined, { lastAccessed: 5 } as Partial<SessionUiCacheEntry>, 99);
    expect(next.lastAccessed).toBe(99);
  });
});

describe("patchTouchesAwaitingInput", () => {
  test("is true only when pendingQuestion or pendingPlan is present as a key", () => {
    expect(patchTouchesAwaitingInput({ pendingQuestion: null })).toBe(true);
    expect(patchTouchesAwaitingInput({ pendingPlan: null })).toBe(true);
    expect(patchTouchesAwaitingInput({ sessionName: "x" })).toBe(false);
  });
});

describe("withSetMember", () => {
  test("always returns a new set", () => {
    const prev = new Set(["a"]);
    const added = withSetMember(prev, "a", true);
    expect(added).not.toBe(prev);
    expect([...added]).toEqual(["a"]);
    expect([...withSetMember(prev, "b", true)].sort()).toEqual(["a", "b"]);
    expect([...withSetMember(prev, "a", false)]).toEqual([]);
    expect([...prev]).toEqual(["a"]);
  });
});

describe("formatMcpStartupReport", () => {
  test("returns null when neither slow nor erroring", () => {
    expect(formatMcpStartupReport({ ts: 1 })).toBeNull();
    expect(formatMcpStartupReport({ ts: 1, slow: true, showSlowWarning: false })).toBeNull();
  });

  test("slow report lists noteworthy servers and a tip", () => {
    const out = formatMcpStartupReport({
      slow: true,
      totalDurationMs: 4200,
      serverTimings: [
        { name: "fast", durationMs: 10, toolCount: 1, timedOut: false },
        { name: "slow", durationMs: 3500, toolCount: 2, timedOut: false },
        { name: "hung", durationMs: 30000, toolCount: 0, timedOut: true },
        { name: "broken", durationMs: 200, toolCount: 0, timedOut: false, error: "boom" },
      ],
    });
    expect(out).toEqual({
      content: [
        "⏱ MCP startup took 4.2s",
        "  ● slow: 3.5s",
        "  ⏱ hung: timed out (30.0s)",
        "  ✗ broken: boom (200ms)",
        "Tip: Use --safe-mode or --no-mcp for instant startup.",
      ].join("\n"),
      isError: false,
    });
  });

  test("errors-only report lists server errors and is flagged as an error", () => {
    const out = formatMcpStartupReport({ errors: [{ server: "gh", error: "401" }] });
    expect(out).toEqual({ content: "⚠ MCP server errors:\n  ✗ gh: 401", isError: true });
  });

  test("slow + errors keeps the slow layout and is flagged as an error", () => {
    const out = formatMcpStartupReport({ slow: true, totalDurationMs: 900, errors: [{ server: "gh", error: "401" }] });
    expect(out?.isError).toBe(true);
    expect(out?.content.startsWith("⏱ MCP startup took 900ms")).toBe(true);
    expect(out?.content).not.toContain("MCP server errors");
  });
});

describe("parsePlanModeSource", () => {
  const fallback = () => "fallback-id";

  test("returns null without a non-empty title", () => {
    expect(parsePlanModeSource(undefined, "t", fallback)).toBeNull();
    expect(parsePlanModeSource({ title: "   " }, "t", fallback)).toBeNull();
    expect(parsePlanModeSource({ title: 5 }, "t", fallback)).toBeNull();
  });

  test("trims title/description/steps and drops empty steps", () => {
    const plan = parsePlanModeSource({
      title: "  Plan  ",
      description: "  do it ",
      steps: [{ title: " one ", description: "  " }, { title: "  " }, null, "x", { title: "two", description: " d " }],
    }, "call-1", fallback);
    expect(plan).toEqual({
      toolCallId: "call-1",
      title: "Plan",
      description: "do it",
      steps: [{ title: "one", description: undefined }, { title: "two", description: "d" }],
    });
  });

  test("uses the fallback id only when toolCallId is not a string", () => {
    let calls = 0;
    const plan = parsePlanModeSource({ title: "P", description: " " }, undefined, () => { calls++; return "fb"; });
    expect(plan?.toolCallId).toBe("fb");
    expect(plan?.description).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("normalizeMetaPendingPlan", () => {
  const pp = { toolCallId: "t", title: " T ", description: " d ", steps: [{ title: " s " }, { title: " " }] };

  test("normalizes a valid plan (steps filtered, not trimmed)", () => {
    expect(normalizeMetaPendingPlan(pp, true)).toEqual({
      toolCallId: "t",
      title: "T",
      description: "d",
      steps: [{ title: " s " }],
    });
  });

  test("snapshot semantics reject a whitespace title; patch semantics accept it", () => {
    const blank = { ...pp, title: "  " };
    expect(normalizeMetaPendingPlan(blank, true)).toBeNull();
    expect(normalizeMetaPendingPlan(blank, false)?.title).toBe("");
  });

  test("rejects non-objects and missing ids", () => {
    expect(normalizeMetaPendingPlan(null, false)).toBeNull();
    expect(normalizeMetaPendingPlan({ title: "x" }, false)).toBeNull();
  });
});

describe("pruneToLiveSessions", () => {
  test("returns the same set when nothing is dropped", () => {
    const prev = new Set(["a"]);
    expect(pruneToLiveSessions(prev, new Set(["a", "b"]))).toBe(prev);
  });

  test("drops sessions that are no longer live", () => {
    expect([...pruneToLiveSessions(new Set(["a", "b"]), new Set(["b"]))]).toEqual(["b"]);
  });
});

describe("sidebar runners", () => {
  test("cache key is user-scoped and absent without a user", () => {
    expect(sidebarRunnersCacheKey("u1")).toBe("pp-sidebar-runners:u1");
    expect(sidebarRunnersCacheKey(null)).toBeNull();
    expect(sidebarRunnersCacheKey(undefined)).toBeNull();
  });

  test("derives rows with per-runner live session counts", () => {
    const runners = [
      { runnerId: "r1", name: "one", version: "1.0" },
      { runnerId: "r2", name: null, version: null },
    ] as unknown as Parameters<typeof deriveSidebarRunners>[0];
    const sessions = [{ runnerId: "r1" }, { runnerId: "r1" }, { runnerId: "r3" }] as HubSession[];
    expect(deriveSidebarRunners(runners, sessions)).toEqual([
      { runnerId: "r1", name: "one", sessionCount: 2, version: "1.0", isOnline: true },
      { runnerId: "r2", name: null, sessionCount: 0, version: null, isOnline: true },
    ]);
  });
});

describe("constants", () => {
  test("stale threshold is 3 heartbeats visible, 18 hidden", () => {
    expect(getStaleThresholdMs(false)).toBe(3 * HEARTBEAT_INTERVAL_MS);
    expect(getStaleThresholdMs(true)).toBe(18 * HEARTBEAT_INTERVAL_MS);
  });

  test("exec ids are timestamp-prefixed and unique", () => {
    const a = makeExecId();
    const b = makeExecId();
    expect(a).toMatch(/^\d+-[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });
});

describe("groupVisibleModels", () => {
  test("filters hidden models and groups by provider in order", () => {
    const models = [
      { provider: "a", id: "1" },
      { provider: "b", id: "2" },
      { provider: "a", id: "3" },
    ] as Parameters<typeof groupVisibleModels>[0];
    const { visibleModels, modelGroups } = groupVisibleModels(models, new Set(["b/2"]));
    expect(visibleModels.map((m) => m.id)).toEqual(["1", "3"]);
    expect([...modelGroups.keys()]).toEqual(["a"]);
    expect(modelGroups.get("a")!.map((m) => m.id)).toEqual(["1", "3"]);
  });
});
