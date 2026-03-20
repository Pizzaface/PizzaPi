import { test, expect, mock } from "bun:test";

test("spawnClaudeCodeSession forwards prompt/model env to bridge", async () => {
  const origSpawn = Bun.spawn;
  let capturedCmd: string[] | undefined;
  let capturedOpts: Record<string, unknown> | undefined;
  (Bun as any).spawn = mock((cmd: string[], opts: Record<string, unknown>) => {
    capturedCmd = cmd;
    capturedOpts = opts;
    return { pid: 12345, exited: Promise.resolve(0) };
  });

  try {
    const { spawnClaudeCodeSession } = await import("./claude-code-bridge-spawn.js");

    const proc = spawnClaudeCodeSession({
      sessionId: "test-session",
      apiKey: "test-key",
      relayUrl: "ws://localhost:7492",
      cwd: "/tmp",
      prompt: "hello",
      parentSessionId: "parent-1",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    });

    expect(proc.pid).toBe(12345);
    expect(capturedCmd).toEqual(["bun", expect.stringContaining("claude-code-bridge.ts")]);
    expect(capturedOpts?.cwd).toBe("/tmp");
    expect(capturedOpts?.env).toMatchObject({
      PIZZAPI_SESSION_ID: "test-session",
      PIZZAPI_WORKER_CWD: "/tmp",
      PIZZAPI_API_KEY: "test-key",
      PIZZAPI_RELAY_URL: "ws://localhost:7492",
      PIZZAPI_WORKER_INITIAL_PROMPT: "hello",
      PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: "anthropic",
      PIZZAPI_WORKER_INITIAL_MODEL_ID: "claude-sonnet-4-6",
      PIZZAPI_WORKER_PARENT_SESSION_ID: "parent-1",
    });
  } finally {
    (Bun as any).spawn = origSpawn;
  }
});
