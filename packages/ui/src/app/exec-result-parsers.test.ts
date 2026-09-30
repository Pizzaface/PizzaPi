import { describe, expect, test } from "bun:test";
import {
  appendUniqueResumeSessions,
  buildMcpCommandResult,
  formatCompactSummary,
  mapPersistedSessions,
  parseForkMessageList,
  parseResumeSessionList,
} from "./exec-result-parsers";

describe("parseResumeSessionList", () => {
  test("keeps only entries with string id/path/modified", () => {
    const out = parseResumeSessionList({
      sessions: [
        { id: "a", path: "/a.jsonl", modified: "2026-01-01", cwd: "/w", name: "A", firstMessage: "hi" },
        { id: "b", path: "/b.jsonl", modified: "2026-01-02", cwd: 5, name: null },
        { id: "c", path: "/c.jsonl" },
        null,
        "junk",
      ],
    });
    expect(out).toEqual([
      { id: "a", path: "/a.jsonl", cwd: "/w", name: "A", modified: "2026-01-01", firstMessage: "hi" },
      { id: "b", path: "/b.jsonl", cwd: null, name: null, modified: "2026-01-02", firstMessage: undefined },
    ]);
  });

  test("tolerates missing / malformed results", () => {
    expect(parseResumeSessionList(undefined)).toEqual([]);
    expect(parseResumeSessionList({ sessions: "nope" })).toEqual([]);
  });
});

describe("parseForkMessageList", () => {
  test("keeps entries with string entryId and text", () => {
    expect(parseForkMessageList({
      messages: [{ entryId: "e1", text: "hello", extra: 1 }, { entryId: 2, text: "x" }, {}],
    })).toEqual([{ entryId: "e1", text: "hello" }]);
    expect(parseForkMessageList(null)).toEqual([]);
  });
});

describe("appendUniqueResumeSessions", () => {
  test("appends only unseen ids", () => {
    const s = (id: string) => ({ id, path: "", cwd: null, name: null, modified: "" });
    expect(appendUniqueResumeSessions([s("a")], [s("a"), s("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("mapPersistedSessions", () => {
  test("maps server rows to server-sourced resume options", () => {
    expect(mapPersistedSessions([{
      sessionId: "s1",
      cwd: "",
      sessionName: "",
      lastActiveAt: "",
      runnerId: "r1",
      runnerName: "Runner",
      startedAt: "2026-01-01",
      endedAt: null,
    }])).toEqual([{
      id: "s1",
      path: "",
      cwd: null,
      name: null,
      modified: "2026-01-01",
      runnerId: "r1",
      runnerName: "Runner",
      serverSourced: true,
    }]);
  });
});

describe("buildMcpCommandResult", () => {
  test("builds the card from a full result", () => {
    const out = buildMcpCommandResult({
      action: "reload",
      toolCount: 3,
      toolNames: ["a", 1, "b"],
      errors: [{ server: "x", error: "y" }],
      config: {
        effectiveServers: [{ name: "gh", transport: "stdio", scope: "user" }],
        disabledServers: ["off", 3],
      },
      serverTools: { gh: ["a", "b"] },
      counts: { totalTools: 3, loadedTools: 2, deferredTools: 1, loadedOnDemandTools: 0, disabledServers: 1 },
      serverStates: [],
      toolStates: [],
      loadedAt: "now",
    });
    expect(out).toEqual({
      kind: "mcp",
      action: "reload",
      toolCount: 3,
      toolNames: ["a", "b"],
      serverCount: 1,
      servers: [{ name: "gh", transport: "stdio", scope: "user" }],
      errors: [{ server: "x", error: "y" }],
      serverTools: { gh: ["a", "b"] },
      disabledServers: ["off"],
      counts: { totalTools: 3, loadedTools: 2, deferredTools: 1, loadedOnDemandTools: 0, disabledServers: 1 },
      serverStates: [],
      toolStates: [],
      loadedAt: "now",
    });
  });

  test("defaults everything for an empty result; action falls back to status", () => {
    expect(buildMcpCommandResult(undefined)).toEqual({
      kind: "mcp",
      action: "status",
      toolCount: 0,
      toolNames: [],
      serverCount: 0,
      servers: [],
      errors: [],
      serverTools: {},
      disabledServers: [],
      counts: undefined,
      serverStates: undefined,
      toolStates: undefined,
      loadedAt: undefined,
    });
  });

  test("forced action wins and array serverTools is rejected", () => {
    const out = buildMcpCommandResult({ action: "status", serverTools: ["x"] }, "reload");
    expect(out.action).toBe("reload");
    expect(out.serverTools).toEqual({});
  });
});

describe("formatCompactSummary", () => {
  test("reports summarized tokens when a summary is present", () => {
    expect(formatCompactSummary({ summary: "s", tokensBefore: 12_345 })).toBe("Compacted (12k tokens summarized)");
    expect(formatCompactSummary({ summary: "s" })).toBe("Compacted (done)");
    expect(formatCompactSummary({})).toBe("Compacted");
  });
});
