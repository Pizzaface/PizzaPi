import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPanelDeepLink, parseMcpToolResultText, parseRequestedModel, splitTopics } from "./index";
import * as panel from "./index";

describe("parseMcpToolResultText", () => {
  test("extracts JSON payload from MCP text content", () => {
    const result = {
      content: [
        { type: "text", text: "[{\"id\":\"abc\",\"status\":\"capture\"}]" },
      ],
      isError: false,
    };

    expect(parseMcpToolResultText(result)).toEqual([
      { id: "abc", status: "capture" },
    ]);
  });

  test("throws on MCP tool error payload", () => {
    const result = {
      content: [{ type: "text", text: "missing argument" }],
      isError: true,
    };

    expect(() => parseMcpToolResultText(result)).toThrow("missing argument");
  });
});

describe("splitTopics", () => {
  test("normalizes comma/newline separated topics", () => {
    expect(splitTopics("bug, ui\nrunner ,bug")).toEqual(["bug", "ui", "runner"]);
  });

  test("returns empty array for blank input", () => {
    expect(splitTopics("   ")).toEqual([]);
  });
});

describe("buildPanelDeepLink", () => {
  test("builds base panel deep link with hash fragment", () => {
    expect(
      buildPanelDeepLink({
        serviceId: "godmother-panel",
        hash: "idea/abc123",
      }),
    ).toBe("pizzapi://panel/godmother-panel#idea/abc123");
  });

  test("preserves sigil query params before hash fragment", () => {
    const query = new URLSearchParams([
      ["view", "list"],
      ["project", "PizzaPi"],
      ["status", "execute"],
    ]);

    expect(
      buildPanelDeepLink({
        serviceId: "godmother-panel",
        query,
        hash: "idea/abc123",
      }),
    ).toBe("pizzapi://panel/godmother-panel?view=list&project=PizzaPi&status=execute#idea/abc123");
  });
});

describe("parseRequestedModel", () => {
  test("trims provider and model id", () => {
    expect(parseRequestedModel({ provider: " anthropic ", id: " claude-sonnet-4-6 " })).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
  });

  test("returns null for blank or malformed input", () => {
    expect(parseRequestedModel(null)).toBeNull();
    expect(parseRequestedModel({ provider: "", id: "x" })).toBeNull();
    expect(parseRequestedModel({ provider: "x", id: "" })).toBeNull();
  });
});

describe("resolveGodmotherMcpConfig", () => {
  test("resolves relative command and cwd against the config directory", () => {
    const cfg = (panel as any).resolveGodmotherMcpConfig(
      {
        command: "./gm",
        args: ["serve", "--config", "./config.json"],
        cwd: "./repo",
      },
      "/Users/jordan/.pizzapi/config.json",
    );

    expect(cfg).toEqual({
      command: "/Users/jordan/.pizzapi/gm",
      args: ["serve", "--config", "/Users/jordan/.pizzapi/config.json"],
      cwd: "/Users/jordan/.pizzapi/repo",
    });
  });
});

describe("panel CSS layout contracts", () => {
  test("avoids generic .wrap selector that collides with .row.wrap", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, "panel", "styles.css"), "utf-8");

    const hasStandaloneWrapRule = /(^|\n)\s*\.wrap\s*\{/m.test(css);
    expect(hasStandaloneWrapRule).toBe(false);
  });
});
