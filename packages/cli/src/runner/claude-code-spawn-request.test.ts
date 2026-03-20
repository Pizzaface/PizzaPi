import { describe, expect, test } from "bun:test";
import { buildSpawnSessionBody } from "./claude-code-spawn-request.js";

describe("buildSpawnSessionBody", () => {
  test("whitelists supported fields and links by default", () => {
    expect(buildSpawnSessionBody({
      prompt: "Fix it",
      cwd: "/tmp/project",
      runnerId: "runner-1",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      workerType: "pi",
      linked: true,
      agent: { name: "danger" },
    }, "parent-1")).toEqual({
      prompt: "Fix it",
      cwd: "/tmp/project",
      runnerId: "runner-1",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      parentSessionId: "parent-1",
    });
  });

  test("omits parent session when linked is false", () => {
    expect(buildSpawnSessionBody({ prompt: "Fix it", linked: false }, "parent-1")).toEqual({
      prompt: "Fix it",
    });
  });

  test("drops malformed model payloads", () => {
    expect(buildSpawnSessionBody({
      prompt: "Fix it",
      model: { provider: "anthropic" },
    }, "parent-1")).toEqual({
      prompt: "Fix it",
      parentSessionId: "parent-1",
    });
  });
});
