import { describe, expect, test, mock } from "bun:test";
import { buildSpawnSessionBody } from "./claude-code-spawn-request.js";

// Mock process.cwd() for consistent testing
const originalCwd = process.cwd;
const mockCwd = mock(() => "/default/project");

describe("buildSpawnSessionBody", () => {
  test("whitelists supported fields and links by default", () => {
    expect(buildSpawnSessionBody({
      prompt: "Fix it",
      cwd: "/tmp/project",
      runnerId: "runner-1",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      linked: true,
      agent: { name: "danger" },
    }, "parent-1")).toEqual({
      prompt: "Fix it",
      cwd: "/tmp/project",
      runnerId: "runner-1",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      parentSessionId: "parent-1",
      workerType: "claude-code",
    });
  });

  test("passes explicit workerType: 'pi' through to body", () => {
    expect(buildSpawnSessionBody({
      prompt: "Fix it",
      cwd: "/tmp/project",
      runnerId: "runner-1",
      workerType: "pi",
    }, "parent-1")).toEqual({
      prompt: "Fix it",
      cwd: "/tmp/project",
      runnerId: "runner-1",
      parentSessionId: "parent-1",
      workerType: "pi",
    });
  });

  test("defaults workerType to claude-code when not provided", () => {
    const result = buildSpawnSessionBody({ prompt: "Hi" }, "parent-1");
    expect(result.workerType).toBe("claude-code");
  });

  test("omits parent session when linked is false", () => {
    // Should still include cwd and runnerId defaults even when linked is false
    const result = buildSpawnSessionBody({ prompt: "Fix it", linked: false }, "parent-1");
    expect(result.prompt).toBe("Fix it");
    expect(result.parentSessionId).toBeUndefined();
    expect(result.cwd).toBeDefined();
    expect(typeof result.cwd).toBe("string");
  });

  test("drops malformed model payloads", () => {
    const result = buildSpawnSessionBody({
      prompt: "Fix it",
      model: { provider: "anthropic" },
    }, "parent-1");
    expect(result.prompt).toBe("Fix it");
    expect(result.parentSessionId).toBe("parent-1");
    expect(result.model).toBeUndefined();
    expect(result.cwd).toBeDefined();
    expect(typeof result.cwd).toBe("string");
  });

  test("defaults cwd to process.cwd() if not provided", () => {
    const result = buildSpawnSessionBody({
      prompt: "Fix it",
      runnerId: "runner-1",
    }, "parent-1");
    expect(result.cwd).toBe(process.cwd());
  });

  test("preserves explicitly provided cwd", () => {
    const result = buildSpawnSessionBody({
      prompt: "Fix it",
      cwd: "/explicit/path",
      runnerId: "runner-1",
    }, "parent-1");
    expect(result.cwd).toBe("/explicit/path");
  });
});
