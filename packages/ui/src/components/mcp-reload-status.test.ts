import { describe, expect, test } from "bun:test";
import { formatMcpReloadMessage } from "./mcp-reload-status";

describe("formatMcpReloadMessage", () => {
  test("reports when there are no active sessions", () => {
    expect(formatMcpReloadMessage({ reloaded: 0, failed: 0 })).toBe(
      "No active sessions were available to reload.",
    );
  });

  test("reports when all active sessions fail to reload", () => {
    expect(formatMcpReloadMessage({ reloaded: 0, failed: 2 })).toBe(
      "Found 2 active sessions, but none could be reloaded.",
    );
  });

  test("reports full success", () => {
    expect(formatMcpReloadMessage({ reloaded: 1, failed: 0 })).toBe(
      "Reloaded MCP in 1 active session.",
    );
  });

  test("reports mixed success and failure", () => {
    expect(formatMcpReloadMessage({ reloaded: 2, failed: 1 })).toBe(
      "Reloaded MCP in 2 active sessions. 1 session could not be reloaded.",
    );
  });
});
