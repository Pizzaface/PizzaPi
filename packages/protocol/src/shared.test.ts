import { describe, expect, test } from "bun:test";
import type {
  SessionInfo,
  ModelInfo,
  RunnerInfo,
  RunnerSkill,
  RunnerAgent,
  RunnerPlugin,
  RunnerHook,
  Attachment,
} from "./shared";

// ---------------------------------------------------------------------------
// These tests verify the protocol contract shapes by constructing objects
// that conform to each interface. If an interface changes in a breaking way,
// TypeScript compilation fails, and the runtime assertions provide extra
// confidence about field presence and types.
// ---------------------------------------------------------------------------

describe("shared types — SessionInfo", () => {
  test("minimal required fields are present", () => {
    const session: SessionInfo = {
      sessionId: "sess-abc",
      shareUrl: "https://example.com/s/abc",
      cwd: "/tmp/workspace",
      startedAt: "2024-01-01T00:00:00Z",
      sessionName: null,
      isEphemeral: false,
      isActive: true,
      lastHeartbeatAt: null,
      model: null,
      runnerId: null,
      runnerName: null,
    };

    expect(typeof session.sessionId).toBe("string");
    expect(typeof session.shareUrl).toBe("string");
    expect(typeof session.cwd).toBe("string");
    expect(typeof session.startedAt).toBe("string");
    expect(typeof session.isEphemeral).toBe("boolean");
    expect(typeof session.isActive).toBe("boolean");
    expect(session.sessionName).toBeNull();
    expect(session.lastHeartbeatAt).toBeNull();
    expect(session.model).toBeNull();
    expect(session.runnerId).toBeNull();
    expect(session.runnerName).toBeNull();
  });

  test("optional fields can be provided", () => {
    const session: SessionInfo = {
      sessionId: "sess-xyz",
      shareUrl: "https://example.com/s/xyz",
      cwd: "/home/user",
      startedAt: "2024-06-01T12:00:00Z",
      sessionName: "My Session",
      isEphemeral: true,
      isActive: false,
      lastHeartbeatAt: "2024-06-01T12:01:00Z",
      model: { provider: "anthropic", id: "claude-3-5-sonnet" },
      runnerId: "runner-1",
      runnerName: "Local Runner",
      viewerCount: 3,
      userId: "user-42",
      userName: "alice",
      expiresAt: "2024-12-31T23:59:59Z",
      parentSessionId: "sess-parent",
    };

    expect(session.viewerCount).toBe(3);
    expect(session.userId).toBe("user-42");
    expect(session.userName).toBe("alice");
    expect(session.expiresAt).toBe("2024-12-31T23:59:59Z");
    expect(session.parentSessionId).toBe("sess-parent");
    expect(typeof session.sessionName).toBe("string");
    expect(session.isEphemeral).toBe(true);
  });

  test("isActive reflects session liveness", () => {
    const active: SessionInfo = {
      sessionId: "s1",
      shareUrl: "u",
      cwd: "/",
      startedAt: "t",
      sessionName: null,
      isEphemeral: false,
      isActive: true,
      lastHeartbeatAt: "2024-01-01T00:00:00Z",
      model: null,
      runnerId: null,
      runnerName: null,
    };
    const inactive: SessionInfo = { ...active, sessionId: "s2", isActive: false, lastHeartbeatAt: null };

    expect(active.isActive).toBe(true);
    expect(inactive.isActive).toBe(false);
  });

  test("parentSessionId can be null, undefined, or a string", () => {
    const withParent: SessionInfo = {
      sessionId: "child",
      shareUrl: "u",
      cwd: "/",
      startedAt: "t",
      sessionName: null,
      isEphemeral: false,
      isActive: true,
      lastHeartbeatAt: null,
      model: null,
      runnerId: null,
      runnerName: null,
      parentSessionId: "parent-123",
    };
    const withoutParent: SessionInfo = {
      ...withParent,
      sessionId: "root",
      parentSessionId: null,
    };

    expect(withParent.parentSessionId).toBe("parent-123");
    expect(withoutParent.parentSessionId).toBeNull();
  });
});

describe("shared types — ModelInfo", () => {
  test("required fields provider and id", () => {
    const model: ModelInfo = {
      provider: "anthropic",
      id: "claude-opus-4",
    };
    expect(typeof model.provider).toBe("string");
    expect(typeof model.id).toBe("string");
    expect(model.name).toBeUndefined();
  });

  test("optional name field", () => {
    const model: ModelInfo = {
      provider: "google",
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
    };
    expect(model.name).toBe("Gemini 2.5 Pro");
  });
});

describe("shared types — RunnerHook", () => {
  test("has type and scripts fields", () => {
    const hook: RunnerHook = {
      type: "PreToolUse",
      scripts: ["rtk-rewrite.sh", "security-check.sh"],
    };
    expect(typeof hook.type).toBe("string");
    expect(Array.isArray(hook.scripts)).toBe(true);
    expect(hook.scripts).toHaveLength(2);
    expect(hook.scripts[0]).toBe("rtk-rewrite.sh");
  });

  test("scripts can be empty", () => {
    const hook: RunnerHook = { type: "PostToolUse", scripts: [] };
    expect(hook.scripts).toHaveLength(0);
  });
});

describe("shared types — RunnerSkill", () => {
  test("has name, description, filePath", () => {
    const skill: RunnerSkill = {
      name: "test-driven-development",
      description: "TDD skill",
      filePath: "/home/user/.pizzapi/skills/tdd/SKILL.md",
    };
    expect(typeof skill.name).toBe("string");
    expect(typeof skill.description).toBe("string");
    expect(typeof skill.filePath).toBe("string");
  });
});

describe("shared types — RunnerAgent", () => {
  test("has name, description, filePath", () => {
    const agent: RunnerAgent = {
      name: "reviewer",
      description: "Code review agent",
      filePath: "/home/user/.pizzapi/agents/reviewer.md",
    };
    expect(typeof agent.name).toBe("string");
    expect(typeof agent.description).toBe("string");
    expect(typeof agent.filePath).toBe("string");
  });
});

describe("shared types — RunnerPlugin", () => {
  test("minimal required fields", () => {
    const plugin: RunnerPlugin = {
      name: "godmother",
      description: "Idea manager",
      rootPath: "/plugins/godmother",
      commands: [],
      hookEvents: [],
      skills: [],
      hasMcp: true,
      hasAgents: false,
      hasLsp: false,
    };

    expect(typeof plugin.name).toBe("string");
    expect(typeof plugin.description).toBe("string");
    expect(typeof plugin.rootPath).toBe("string");
    expect(Array.isArray(plugin.commands)).toBe(true);
    expect(Array.isArray(plugin.hookEvents)).toBe(true);
    expect(Array.isArray(plugin.skills)).toBe(true);
    expect(typeof plugin.hasMcp).toBe("boolean");
    expect(typeof plugin.hasAgents).toBe("boolean");
    expect(typeof plugin.hasLsp).toBe("boolean");
  });

  test("commands can have description and argumentHint", () => {
    const plugin: RunnerPlugin = {
      name: "test-plugin",
      description: "desc",
      rootPath: "/tmp",
      commands: [
        { name: "run", description: "Run tests", argumentHint: "<path>" },
        { name: "clean" }, // only name required
      ],
      hookEvents: ["PreToolUse"],
      skills: [{ name: "some-skill", dirPath: "/tmp/skills/some-skill" }],
      agents: [{ name: "test-agent" }],
      rules: [{ name: "rule-1" }],
      hasMcp: false,
      hasAgents: true,
      hasLsp: false,
      version: "1.2.3",
      author: "Jordan",
    };

    expect(plugin.commands[0].argumentHint).toBe("<path>");
    expect(plugin.commands[1].description).toBeUndefined();
    expect(plugin.agents).toHaveLength(1);
    expect(plugin.rules).toHaveLength(1);
    expect(plugin.version).toBe("1.2.3");
    expect(plugin.author).toBe("Jordan");
  });
});

describe("shared types — RunnerInfo", () => {
  test("required fields", () => {
    const info: RunnerInfo = {
      runnerId: "runner-abc",
      name: "My Runner",
      roots: ["/home/user/projects"],
      sessionCount: 2,
      skills: [],
      agents: [],
      version: "1.0.0",
    };

    expect(typeof info.runnerId).toBe("string");
    expect(typeof info.sessionCount).toBe("number");
    expect(Array.isArray(info.roots)).toBe(true);
    expect(Array.isArray(info.skills)).toBe(true);
    expect(Array.isArray(info.agents)).toBe(true);
  });

  test("name can be null", () => {
    const info: RunnerInfo = {
      runnerId: "r1",
      name: null,
      roots: [],
      sessionCount: 0,
      skills: [],
      agents: [],
      version: null,
    };
    expect(info.name).toBeNull();
    expect(info.version).toBeNull();
  });

  test("optional plugins and hooks", () => {
    const info: RunnerInfo = {
      runnerId: "r2",
      name: "Runner",
      roots: [],
      sessionCount: 1,
      skills: [],
      agents: [],
      plugins: [
        {
          name: "p",
          description: "d",
          rootPath: "/",
          commands: [],
          hookEvents: [],
          skills: [],
          hasMcp: false,
          hasAgents: false,
          hasLsp: false,
        },
      ],
      hooks: [{ type: "PreToolUse", scripts: ["hook.sh"] }],
      version: "2.0.0",
    };
    expect(info.plugins).toHaveLength(1);
    expect(info.hooks).toHaveLength(1);
  });
});

describe("shared types — Attachment", () => {
  test("all fields are optional", () => {
    const empty: Attachment = {};
    expect(empty.attachmentId).toBeUndefined();
    expect(empty.mediaType).toBeUndefined();
    expect(empty.filename).toBeUndefined();
    expect(empty.url).toBeUndefined();
  });

  test("can be fully populated", () => {
    const full: Attachment = {
      attachmentId: "att-1",
      mediaType: "image/png",
      filename: "screenshot.png",
      url: "https://cdn.example.com/att-1.png",
    };
    expect(full.attachmentId).toBe("att-1");
    expect(full.mediaType).toBe("image/png");
    expect(full.filename).toBe("screenshot.png");
    expect(full.url).toBe("https://cdn.example.com/att-1.png");
  });
});
