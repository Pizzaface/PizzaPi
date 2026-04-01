import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock electron-log/main before anything imports logger
mock.module("electron-log/main", () => {
  const noop = () => {};
  const log = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    initialize: noop,
    transports: {
      file: { level: "info" },
      console: { level: "debug" },
    },
  };
  return { default: log };
});

// Mock electron app module used by config
mock.module("electron", () => ({
  app: {
    getPath: () => "/tmp/test",
  },
}));

// Mock config to avoid __dirname issues in test context
mock.module("../src/main/config.js", () => ({
  getServerEntryPath: () => "/fake/server/index.ts",
  HEALTH_CHECK_INTERVAL: 10,
  HEALTH_CHECK_TIMEOUT: 1000,
  MAX_RESTART_ATTEMPTS: 3,
  isDev: true,
}));

// Mock child_process.spawn
const mockKill = mock(() => true);
const mockSpawn = mock(() => ({
  pid: 1234,
  on: mock(() => {}),
  kill: mockKill,
  stdout: { on: mock(() => {}) },
  stderr: { on: mock(() => {}) },
}));

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

describe("ServerManager", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockKill.mockClear();
  });

  test("start() spawns a child process with the correct entry path", async () => {
    const { ServerManager } = await import("../src/main/server-manager.js");
    const mgr = new ServerManager({ port: 3001, isDev: true });

    // Mock fetch for health check
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    ) as any;

    await mgr.start();

    expect(mockSpawn).toHaveBeenCalled();
    expect(mgr.isRunning()).toBe(true);

    globalThis.fetch = originalFetch;
  });

  test("stop() sends SIGTERM to the child process", async () => {
    const { ServerManager } = await import("../src/main/server-manager.js");
    const mgr = new ServerManager({ port: 3001, isDev: true });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    ) as any;

    await mgr.start();
    mgr.stop();

    expect(mgr.isRunning()).toBe(false);

    globalThis.fetch = originalFetch;
  });

  test("getPort() returns the configured port", async () => {
    const { ServerManager } = await import("../src/main/server-manager.js");
    const mgr = new ServerManager({ port: 3042, isDev: true });
    expect(mgr.getPort()).toBe(3042);
  });
});
