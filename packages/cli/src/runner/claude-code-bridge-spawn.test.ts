import { test, expect, mock } from "bun:test";

test("spawnClaudeCodeSession does not throw with valid options", async () => {
  // Mock Bun.spawn to avoid actually spawning a process
  const origSpawn = Bun.spawn;
  (Bun as any).spawn = mock(() => ({ pid: 12345, exited: Promise.resolve(0) }));

  const { spawnClaudeCodeSession } = await import("./claude-code-bridge-spawn.js");

  expect(() =>
    spawnClaudeCodeSession({
      sessionId: "test-session",
      apiKey: "test-key",
      relayUrl: "ws://localhost:7492",
      cwd: "/tmp",
    })
  ).not.toThrow();

  (Bun as any).spawn = origSpawn;
});
