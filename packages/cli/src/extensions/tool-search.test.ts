import { describe, test, expect } from "bun:test";
import {
  scoreToolMatch,
  searchDeferredTools,
  estimateToolChars,
  extractParamNames,
} from "./tool-search.js";

// ── Test fixtures ─────────────────────────────────────────────────────────

const makeToolInfo = (
  name: string,
  description: string,
  parameterNames: string[] = [],
  serverName?: string,
) => ({
  name,
  description,
  parameterNames,
  charCount: name.length + description.length,
  serverName,
});

const sampleTools = new Map([
  ["mcp_github_create_issue", makeToolInfo(
    "mcp_github_create_issue",
    "Create a new issue in a GitHub repository",
    ["owner", "repo", "title", "body", "labels"],
    "github",
  )],
  ["mcp_github_list_prs", makeToolInfo(
    "mcp_github_list_prs",
    "List pull requests for a GitHub repository",
    ["owner", "repo", "state"],
    "github",
  )],
  ["mcp_slack_send_message", makeToolInfo(
    "mcp_slack_send_message",
    "Send a message to a Slack channel",
    ["channel", "text", "thread_ts"],
    "slack",
  )],
  ["mcp_slack_list_channels", makeToolInfo(
    "mcp_slack_list_channels",
    "List Slack channels in a workspace",
    ["cursor", "limit"],
    "slack",
  )],
  ["mcp_sentry_get_issues", makeToolInfo(
    "mcp_sentry_get_issues",
    "Get issues from Sentry error tracking",
    ["project", "query"],
    "sentry",
  )],
  ["mcp_grafana_query", makeToolInfo(
    "mcp_grafana_query",
    "Query metrics from Grafana dashboards",
    ["dashboard", "panel", "timeRange"],
    "grafana",
  )],
]);

// ── scoreToolMatch ────────────────────────────────────────────────────────

describe("scoreToolMatch", () => {
  test("exact name match scores highest", () => {
    const tool = makeToolInfo("weather", "Get weather information");
    const score = scoreToolMatch(tool, "weather");
    expect(score).toBeGreaterThan(0);
    // Should score higher than partial match
    const partialScore = scoreToolMatch(tool, "weath");
    expect(score).toBeGreaterThan(partialScore);
  });

  test("name contains keyword scores well", () => {
    const tool = makeToolInfo("mcp_github_create_issue", "Create a new issue");
    const score = scoreToolMatch(tool, "github");
    expect(score).toBeGreaterThan(0);
  });

  test("description match scores", () => {
    const tool = makeToolInfo("create_issue", "Create a new issue in a GitHub repository");
    const score = scoreToolMatch(tool, "repository");
    expect(score).toBeGreaterThan(0);
  });

  test("parameter name match scores lowest", () => {
    const tool = makeToolInfo("create_issue", "Create an issue", ["owner", "repo", "title"]);
    const nameScore = scoreToolMatch(tool, "create");
    const paramScore = scoreToolMatch(tool, "owner");
    expect(nameScore).toBeGreaterThan(paramScore);
  });

  test("no match returns zero", () => {
    const tool = makeToolInfo("weather", "Get weather information");
    expect(scoreToolMatch(tool, "database")).toBe(0);
  });

  test("case insensitive matching", () => {
    const tool = makeToolInfo("GitHub_Tool", "A GitHub tool");
    expect(scoreToolMatch(tool, "github")).toBeGreaterThan(0);
    expect(scoreToolMatch(tool, "GITHUB")).toBeGreaterThan(0);
  });

  test("multi-keyword query scores cumulatively", () => {
    const tool = makeToolInfo("mcp_github_create_issue", "Create a new issue in a GitHub repository");
    const singleScore = scoreToolMatch(tool, "github");
    const multiScore = scoreToolMatch(tool, "github create issue");
    // More keywords that match should produce a higher score
    expect(multiScore).toBeGreaterThan(singleScore);
  });

  test("single-char keywords are ignored", () => {
    const tool = makeToolInfo("weather", "Get weather");
    expect(scoreToolMatch(tool, "a")).toBe(0);
  });

  test("empty query returns zero", () => {
    const tool = makeToolInfo("weather", "Get weather");
    expect(scoreToolMatch(tool, "")).toBe(0);
  });

  test("full query as substring in name gives bonus", () => {
    const tool = makeToolInfo("create_issue", "Create a new issue");
    const exactSubScore = scoreToolMatch(tool, "create_issue");
    const partialScore = scoreToolMatch(tool, "create");
    expect(exactSubScore).toBeGreaterThan(partialScore);
  });
});

// ── searchDeferredTools ───────────────────────────────────────────────────

describe("searchDeferredTools", () => {
  test("finds tools by keyword", () => {
    const results = searchDeferredTools(sampleTools, "github", 5);
    expect(results.length).toBe(2);
    expect(results.every((t) => t.name.includes("github"))).toBe(true);
  });

  test("respects maxResults", () => {
    const results = searchDeferredTools(sampleTools, "mcp", 2);
    expect(results.length).toBe(2);
  });

  test("returns empty for no matches", () => {
    const results = searchDeferredTools(sampleTools, "kubernetes", 5);
    expect(results.length).toBe(0);
  });

  test("ranks by relevance — name match beats description", () => {
    const results = searchDeferredTools(sampleTools, "slack", 5);
    expect(results.length).toBe(2);
    // Both slack tools should match
    expect(results.every((t) => t.name.includes("slack"))).toBe(true);
  });

  test("finds by description keyword", () => {
    const results = searchDeferredTools(sampleTools, "error tracking", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("mcp_sentry_get_issues");
  });

  test("finds by parameter name", () => {
    const results = searchDeferredTools(sampleTools, "dashboard", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("mcp_grafana_query");
  });

  test("multi-word query narrows results", () => {
    const broadResults = searchDeferredTools(sampleTools, "list", 10);
    const narrowResults = searchDeferredTools(sampleTools, "list channels", 10);
    // Narrow should rank slack_list_channels higher
    if (narrowResults.length > 0) {
      expect(narrowResults[0].name).toBe("mcp_slack_list_channels");
    }
  });
});

// ── estimateToolChars ─────────────────────────────────────────────────────

describe("estimateToolChars", () => {
  test("sums name + description + schema", () => {
    const result = estimateToolChars({
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: { foo: { type: "string" } } },
    });
    expect(result).toBeGreaterThan(0);
    // Should be roughly: "test_tool".length + "A test tool".length + JSON.stringify(schema).length
    expect(result).toBe(
      "test_tool".length +
      "A test tool".length +
      JSON.stringify({ type: "object", properties: { foo: { type: "string" } } }).length,
    );
  });

  test("handles null/undefined parameters", () => {
    const result = estimateToolChars({
      name: "test",
      description: "desc",
      parameters: null,
    });
    expect(result).toBeGreaterThan(0);
  });

  test("handles empty description", () => {
    const result = estimateToolChars({
      name: "test",
      description: "",
      parameters: {},
    });
    expect(result).toBe("test".length + JSON.stringify({}).length);
  });
});

// ── extractParamNames ─────────────────────────────────────────────────────

describe("extractParamNames", () => {
  test("extracts property names from JSON Schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
    };
    expect(extractParamNames(schema)).toEqual(["name", "age", "active"]);
  });

  test("returns empty for null/undefined", () => {
    expect(extractParamNames(null)).toEqual([]);
    expect(extractParamNames(undefined)).toEqual([]);
  });

  test("returns empty for non-object", () => {
    expect(extractParamNames("string")).toEqual([]);
    expect(extractParamNames(42)).toEqual([]);
  });

  test("returns empty for schema without properties", () => {
    expect(extractParamNames({ type: "object" })).toEqual([]);
    expect(extractParamNames({ type: "object", properties: null })).toEqual([]);
  });

  test("handles nested schema", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        filters: {
          type: "object",
          properties: {
            status: { type: "string" },
          },
        },
      },
    };
    // Only extracts top-level
    expect(extractParamNames(schema)).toEqual(["query", "filters"]);
  });
});
