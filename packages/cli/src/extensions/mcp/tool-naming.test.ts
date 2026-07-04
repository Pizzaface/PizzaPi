import { describe, expect, test } from "bun:test";
import { allocateProviderSafeToolName } from "./tool-naming.js";

describe("allocateProviderSafeToolName", () => {
  test("uses Claude Code's mcp__<server>__<tool> double-underscore convention", () => {
    // Anthropic's subscription-lane classifier rejects `mcp_x_y` (single
    // underscore) names into the metered extra-usage lane. Only the CC-style
    // `mcp__x__y` shape passes. Regression-guard the separator.
    const name = allocateProviderSafeToolName("godmother", "capture_idea", new Set());
    expect(name).toBe("mcp__godmother__capture_idea");
  });

  test("sanitizes and lowercases parts without breaking the __ separators", () => {
    const name = allocateProviderSafeToolName("My Server!", "Do.Thing", new Set());
    expect(name).toBe("mcp__my_server__do_thing");
  });

  test("deduplicates collisions with a hash suffix", () => {
    const used = new Set<string>();
    const first = allocateProviderSafeToolName("srv", "tool", used);
    const second = allocateProviderSafeToolName("srv", "tool", used);
    expect(first).toBe("mcp__srv__tool");
    expect(second).not.toBe(first);
    expect(second.startsWith("mcp__srv__tool_")).toBe(true);
  });

  test("clamps long names to 64 chars", () => {
    const name = allocateProviderSafeToolName("server", "x".repeat(100), new Set());
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("mcp__server__")).toBe(true);
  });
});
