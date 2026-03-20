import { test, expect, spyOn } from "bun:test";
import { spawnClaudeCodeSession } from "./claude-code-bridge-spawn.js";

test("spawnClaudeCodeSession stub logs a warning and does not throw", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  expect(() =>
    spawnClaudeCodeSession({
      sessionId: "test-session-id",
      apiKey: "test-key",
      relayUrl: "ws://localhost:7492",
      cwd: "/tmp",
    })
  ).not.toThrow();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("not yet implemented"));
  warn.mockRestore();
});
