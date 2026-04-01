import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock electron-log/main before anything imports logger
mock.module("electron-log/main", () => ({
  default: {
    initialize: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    transports: {
      file: { level: "info" },
      console: { level: "debug" },
    },
  },
}));

// Mock electron app module (used by config.ts)
mock.module("electron", () => ({
  app: {
    getPath: mock(() => "/tmp/test"),
  },
}));

// Mock config to avoid __dirname issues in test
mock.module("../src/main/config.js", () => ({
  getRunnerEntryPath: () => "/fake/runner/index.js",
  MAX_RESTART_ATTEMPTS: 3,
}));

const mockKill = mock(() => true);
const mockStdoutOn = mock(() => {});
const mockStderrOn = mock(() => {});
const mockOn = mock(() => {});

const mockSpawn = mock(() => ({
  pid: 5678,
  on: mockOn,
  kill: mockKill,
  stdout: { on: mockStdoutOn },
  stderr: { on: mockStderrOn },
}));

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

describe("RunnerManager", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockKill.mockClear();
    mockOn.mockClear();
  });

  test("start() spawns the runner daemon pointing at the local server", async () => {
    const { RunnerManager } = await import("../src/main/runner-manager.js");
    const mgr = new RunnerManager({ serverPort: 3001, isDev: true });

    mgr.start();

    expect(mockSpawn).toHaveBeenCalled();
    expect(mgr.isRunning()).toBe(true);
  });

  test("stop() sends SIGTERM to runner", async () => {
    const { RunnerManager } = await import("../src/main/runner-manager.js");
    const mgr = new RunnerManager({ serverPort: 3001, isDev: true });

    mgr.start();
    mgr.stop();

    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    expect(mgr.isRunning()).toBe(false);
  });
});
