import { describe, expect, test } from "bun:test";
import type {
  RunnerClientToServerEvents,
  RunnerServerToClientEvents,
  RunnerInterServerEvents,
  RunnerSocketData,
} from "./runner";
import type { RunnerSkill, RunnerAgent, RunnerPlugin, RunnerHook } from "./shared";

// ---------------------------------------------------------------------------
// Runner namespace tests
// Verifies event payload shapes for the /runner namespace.
// ---------------------------------------------------------------------------

// Shared fixtures
const skill: RunnerSkill = { name: "tdd", description: "TDD", filePath: "/skills/tdd.md" };
const agent: RunnerAgent = { name: "reviewer", description: "Review", filePath: "/agents/reviewer.md" };
const plugin: RunnerPlugin = {
  name: "godmother",
  description: "Ideas",
  rootPath: "/plugins/godmother",
  commands: [],
  hookEvents: [],
  skills: [],
  hasMcp: true,
  hasAgents: false,
  hasLsp: false,
};
const hook: RunnerHook = { type: "PreToolUse", scripts: ["rtk.sh"] };

describe("runner — RunnerClientToServerEvents payloads", () => {
  test("register_runner all fields are optional", () => {
    type Payload = Parameters<RunnerClientToServerEvents["register_runner"]>[0];

    const minimal: Payload = {};
    expect(minimal.name).toBeUndefined();
    expect(minimal.roots).toBeUndefined();
    expect(minimal.runnerId).toBeUndefined();

    const full: Payload = {
      name: "Dev Runner",
      roots: ["/home/user/projects"],
      runnerId: "r-abc",
      runnerSecret: "secret-xyz",
      skills: [skill],
      agents: [agent],
      plugins: [plugin],
      hooks: [hook],
      version: "1.0.0",
    };
    expect(full.name).toBe("Dev Runner");
    expect(full.roots).toHaveLength(1);
    expect(full.skills).toHaveLength(1);
    expect(full.version).toBe("1.0.0");
  });

  test("skills_list carries skills array with optional requestId", () => {
    type Payload = Parameters<RunnerClientToServerEvents["skills_list"]>[0];
    const p: Payload = { skills: [skill], requestId: "req-1" };
    expect(Array.isArray(p.skills)).toBe(true);
    expect(p.requestId).toBe("req-1");
  });

  test("plugins_list carries plugins array with optional metadata", () => {
    type Payload = Parameters<RunnerClientToServerEvents["plugins_list"]>[0];
    const success: Payload = {
      plugins: [plugin],
      requestId: "req-2",
      ok: true,
    };
    expect(success.ok).toBe(true);
    expect(success.plugins).toHaveLength(1);

    const rejected: Payload = {
      plugins: [],
      ok: false,
      message: "Invalid cwd",
      scoped: true,
    };
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toBe("Invalid cwd");
    expect(rejected.scoped).toBe(true);
  });

  test("agents_list carries agents array", () => {
    type Payload = Parameters<RunnerClientToServerEvents["agents_list"]>[0];
    const p: Payload = { agents: [agent], requestId: "req-3" };
    expect(Array.isArray(p.agents)).toBe(true);
  });

  test("agent_result carries ok flag with optional data", () => {
    type Payload = Parameters<RunnerClientToServerEvents["agent_result"]>[0];

    const success: Payload = {
      ok: true,
      agents: [agent],
      name: "reviewer",
      content: "# Reviewer\n...",
      requestId: "req-4",
    };
    expect(success.ok).toBe(true);
    expect(success.name).toBe("reviewer");

    const failure: Payload = { ok: false, message: "Agent not found" };
    expect(failure.ok).toBe(false);
    expect(failure.message).toBe("Agent not found");
  });

  test("skill_result carries ok flag with optional data", () => {
    type Payload = Parameters<RunnerClientToServerEvents["skill_result"]>[0];

    const success: Payload = {
      ok: true,
      skills: [skill],
      name: "tdd",
      content: "# TDD Skill\n...",
    };
    expect(success.ok).toBe(true);
    expect(success.skills).toHaveLength(1);

    const failure: Payload = { ok: false, message: "Skill write failed" };
    expect(failure.message).toBe("Skill write failed");
  });

  test("file_result carries optional ok and arbitrary keys", () => {
    type Payload = Parameters<RunnerClientToServerEvents["file_result"]>[0];
    const p: Payload = { ok: true, entries: ["a.ts", "b.ts"], requestId: "r1" };
    expect(p.ok).toBe(true);
    expect(p.entries).toEqual(["a.ts", "b.ts"]);
  });

  test("runner_session_event carries sessionId and event", () => {
    type Payload = Parameters<RunnerClientToServerEvents["runner_session_event"]>[0];
    const p: Payload = {
      sessionId: "sess-1",
      event: { type: "heartbeat", ts: "2024-01-01T00:00:00Z" },
    };
    expect(typeof p.sessionId).toBe("string");
    expect(p.event).toBeDefined();
  });

  test("session_ready carries sessionId", () => {
    type Payload = Parameters<RunnerClientToServerEvents["session_ready"]>[0];
    const p: Payload = { sessionId: "sess-2" };
    expect(typeof p.sessionId).toBe("string");
  });

  test("session_error carries sessionId and message", () => {
    type Payload = Parameters<RunnerClientToServerEvents["session_error"]>[0];
    const p: Payload = { sessionId: "sess-3", message: "Worker crashed" };
    expect(typeof p.message).toBe("string");
  });

  test("session_killed carries sessionId", () => {
    type Payload = Parameters<RunnerClientToServerEvents["session_killed"]>[0];
    const p: Payload = { sessionId: "sess-4" };
    expect(typeof p.sessionId).toBe("string");
  });

  test("disconnect_session carries sessionId", () => {
    type Payload = Parameters<RunnerClientToServerEvents["disconnect_session"]>[0];
    const p: Payload = { sessionId: "sess-5" };
    expect(typeof p.sessionId).toBe("string");
  });

  test("terminal_ready, terminal_data, terminal_exit, terminal_error", () => {
    type ReadyPayload = Parameters<RunnerClientToServerEvents["terminal_ready"]>[0];
    type DataPayload = Parameters<RunnerClientToServerEvents["terminal_data"]>[0];
    type ExitPayload = Parameters<RunnerClientToServerEvents["terminal_exit"]>[0];
    type ErrorPayload = Parameters<RunnerClientToServerEvents["terminal_error"]>[0];

    const ready: ReadyPayload = { terminalId: "t1" };
    const data: DataPayload = { terminalId: "t1", data: "output" };
    const exit: ExitPayload = { terminalId: "t1", exitCode: 0 };
    const error: ErrorPayload = { terminalId: "t1", message: "PTY error" };

    expect(ready.terminalId).toBe("t1");
    expect(data.data).toBe("output");
    expect(exit.exitCode).toBe(0);
    expect(error.message).toBe("PTY error");
  });
});

describe("runner — RunnerServerToClientEvents payloads", () => {
  test("runner_registered carries runnerId with optional existingSessions", () => {
    type Payload = Parameters<RunnerServerToClientEvents["runner_registered"]>[0];

    const minimal: Payload = { runnerId: "r-1" };
    expect(typeof minimal.runnerId).toBe("string");
    expect(minimal.existingSessions).toBeUndefined();

    const withSessions: Payload = {
      runnerId: "r-1",
      existingSessions: [
        { sessionId: "sess-1", cwd: "/home/user" },
        { sessionId: "sess-2", cwd: "/tmp" },
      ],
    };
    expect(withSessions.existingSessions).toHaveLength(2);
    expect(withSessions.existingSessions![0].sessionId).toBe("sess-1");
  });

  test("new_session carries sessionId with optional config", () => {
    type Payload = Parameters<RunnerServerToClientEvents["new_session"]>[0];

    const minimal: Payload = { sessionId: "sess-new" };
    expect(typeof minimal.sessionId).toBe("string");
    expect(minimal.cwd).toBeUndefined();
    expect(minimal.prompt).toBeUndefined();

    const full: Payload = {
      sessionId: "sess-new-2",
      cwd: "/home/user/project",
      prompt: "Implement feature X",
      model: { provider: "anthropic", id: "claude-opus-4" },
      skills: ["tdd", "review"],
      hiddenModels: ["openai/gpt-4o"],
      agent: {
        name: "reviewer",
        systemPrompt: "You are a code reviewer",
        tools: "bash,read",
        disallowedTools: "write",
      },
      parentSessionId: "parent-sess",
    };
    expect(full.cwd).toBe("/home/user/project");
    expect(full.model?.provider).toBe("anthropic");
    expect(full.skills).toHaveLength(2);
    expect(full.hiddenModels).toHaveLength(1);
    expect(full.agent?.name).toBe("reviewer");
    expect(full.parentSessionId).toBe("parent-sess");
  });

  test("kill_session carries sessionId", () => {
    type Payload = Parameters<RunnerServerToClientEvents["kill_session"]>[0];
    const p: Payload = { sessionId: "sess-to-kill" };
    expect(typeof p.sessionId).toBe("string");
  });

  test("session_ended carries sessionId", () => {
    type Payload = Parameters<RunnerServerToClientEvents["session_ended"]>[0];
    const p: Payload = { sessionId: "sess-ended" };
    expect(typeof p.sessionId).toBe("string");
  });

  test("list_sessions, restart, shutdown, ping send empty records", () => {
    type ListPayload = Parameters<RunnerServerToClientEvents["list_sessions"]>[0];
    type RestartPayload = Parameters<RunnerServerToClientEvents["restart"]>[0];
    type ShutdownPayload = Parameters<RunnerServerToClientEvents["shutdown"]>[0];
    type PingPayload = Parameters<RunnerServerToClientEvents["ping"]>[0];

    const list: ListPayload = {};
    const restart: RestartPayload = {};
    const shutdown: ShutdownPayload = {};
    const ping: PingPayload = {};

    expect(Object.keys(list)).toHaveLength(0);
    expect(Object.keys(restart)).toHaveLength(0);
    expect(Object.keys(shutdown)).toHaveLength(0);
    expect(Object.keys(ping)).toHaveLength(0);
  });

  test("new_terminal carries terminalId with optional config", () => {
    type Payload = Parameters<RunnerServerToClientEvents["new_terminal"]>[0];

    const minimal: Payload = { terminalId: "term-new" };
    expect(typeof minimal.terminalId).toBe("string");
    expect(minimal.cwd).toBeUndefined();
    expect(minimal.cols).toBeUndefined();

    const full: Payload = {
      terminalId: "term-full",
      cwd: "/home/user",
      shell: "/bin/zsh",
      cols: 200,
      rows: 50,
    };
    expect(full.shell).toBe("/bin/zsh");
    expect(full.cols).toBe(200);
    expect(full.rows).toBe(50);
  });

  test("terminal_input, terminal_resize, kill_terminal", () => {
    type InputPayload = Parameters<RunnerServerToClientEvents["terminal_input"]>[0];
    type ResizePayload = Parameters<RunnerServerToClientEvents["terminal_resize"]>[0];
    type KillPayload = Parameters<RunnerServerToClientEvents["kill_terminal"]>[0];

    const input: InputPayload = { terminalId: "t1", data: "ls\r" };
    const resize: ResizePayload = { terminalId: "t1", cols: 120, rows: 30 };
    const kill: KillPayload = { terminalId: "t1" };

    expect(input.data).toBe("ls\r");
    expect(resize.cols).toBe(120);
    expect(kill.terminalId).toBe("t1");
  });

  test("list_agents carries optional requestId", () => {
    type Payload = Parameters<RunnerServerToClientEvents["list_agents"]>[0];
    const minimal: Payload = {};
    const withId: Payload = { requestId: "req-1" };
    expect(minimal.requestId).toBeUndefined();
    expect(withId.requestId).toBe("req-1");
  });

  test("create_agent, update_agent carry name and content", () => {
    type CreatePayload = Parameters<RunnerServerToClientEvents["create_agent"]>[0];
    type UpdatePayload = Parameters<RunnerServerToClientEvents["update_agent"]>[0];

    const create: CreatePayload = { name: "new-agent", content: "# New Agent\n..." };
    const update: UpdatePayload = { name: "reviewer", content: "# Updated\n..." };

    expect(typeof create.name).toBe("string");
    expect(typeof create.content).toBe("string");
    expect(typeof update.name).toBe("string");
  });

  test("delete_agent, get_agent carry name", () => {
    type DeletePayload = Parameters<RunnerServerToClientEvents["delete_agent"]>[0];
    type GetPayload = Parameters<RunnerServerToClientEvents["get_agent"]>[0];

    const del: DeletePayload = { name: "old-agent" };
    const get: GetPayload = { name: "reviewer" };

    expect(typeof del.name).toBe("string");
    expect(typeof get.name).toBe("string");
  });

  test("list_skills carries optional requestId", () => {
    type Payload = Parameters<RunnerServerToClientEvents["list_skills"]>[0];
    const p: Payload = { requestId: "req-skills" };
    expect(p.requestId).toBe("req-skills");
  });

  test("list_plugins carries optional requestId and cwd", () => {
    type Payload = Parameters<RunnerServerToClientEvents["list_plugins"]>[0];
    const minimal: Payload = {};
    const withCwd: Payload = { requestId: "req-p", cwd: "/home/user/project" };
    expect(minimal.cwd).toBeUndefined();
    expect(withCwd.cwd).toBe("/home/user/project");
  });

  test("create_skill, update_skill carry name and content", () => {
    type CreatePayload = Parameters<RunnerServerToClientEvents["create_skill"]>[0];
    type UpdatePayload = Parameters<RunnerServerToClientEvents["update_skill"]>[0];

    const create: CreatePayload = { name: "new-skill", content: "# New Skill\n..." };
    const update: UpdatePayload = { name: "tdd", content: "# Updated TDD\n..." };

    expect(create.name).toBe("new-skill");
    expect(update.name).toBe("tdd");
  });

  test("delete_skill, get_skill carry name", () => {
    type DeletePayload = Parameters<RunnerServerToClientEvents["delete_skill"]>[0];
    type GetPayload = Parameters<RunnerServerToClientEvents["get_skill"]>[0];

    const del: DeletePayload = { name: "old-skill" };
    const get: GetPayload = { name: "tdd" };
    expect(del.name).toBe("old-skill");
    expect(get.name).toBe("tdd");
  });

  test("list_files carries cwd and path", () => {
    type Payload = Parameters<RunnerServerToClientEvents["list_files"]>[0];
    const p: Payload = { cwd: "/home/user", path: "src/" };
    expect(typeof p.cwd).toBe("string");
    expect(typeof p.path).toBe("string");
  });

  test("search_files carries cwd and query with optional limit", () => {
    type Payload = Parameters<RunnerServerToClientEvents["search_files"]>[0];
    const minimal: Payload = { cwd: "/home/user", query: "*.ts" };
    const withLimit: Payload = { cwd: "/home/user", query: "*.ts", limit: 50 };
    expect(minimal.limit).toBeUndefined();
    expect(withLimit.limit).toBe(50);
  });

  test("read_file carries cwd and path", () => {
    type Payload = Parameters<RunnerServerToClientEvents["read_file"]>[0];
    const p: Payload = { cwd: "/home/user", path: "src/index.ts" };
    expect(typeof p.cwd).toBe("string");
    expect(typeof p.path).toBe("string");
  });

  test("git operations use service_message channel (no dedicated events)", () => {
    // git_status and git_diff were removed from RunnerServerToClientEvents
    // in favor of the generic service_message channel with serviceId="git".
    type Events = RunnerServerToClientEvents;
    type ServiceMsg = Parameters<Events["service_message"]>[0];

    const envelope: ServiceMsg = {
      serviceId: "git",
      type: "git_status",
      payload: { cwd: "/home/user/project" },
      requestId: "r1",
    };

    expect(envelope.serviceId).toBe("git");
    expect(envelope.type).toBe("git_status");
    expect(envelope.requestId).toBe("r1");
  });

  test("sandbox_get_status has optional requestId", () => {
    type Payload = Parameters<RunnerServerToClientEvents["sandbox_get_status"]>[0];
    const p: Payload = {};
    const withId: Payload = { requestId: "r1" };
    expect(p.requestId).toBeUndefined();
    expect(withId.requestId).toBe("r1");
  });

  test("sandbox_update_config carries config object", () => {
    type Payload = Parameters<RunnerServerToClientEvents["sandbox_update_config"]>[0];
    const p: Payload = {
      config: { mode: "strict", allow: ["/tmp"] },
      requestId: "req-sandbox",
    };
    expect(p.config).toBeDefined();
    expect(typeof p.config).toBe("object");
  });

  test("error carries message string", () => {
    type Payload = Parameters<RunnerServerToClientEvents["error"]>[0];
    const p: Payload = { message: "Runner not found" };
    expect(typeof p.message).toBe("string");
  });
});

describe("runner — RunnerSocketData", () => {
  test("all fields are optional", () => {
    const empty: RunnerSocketData = {};
    expect(empty.runnerId).toBeUndefined();
    expect(empty.runnerName).toBeUndefined();
    expect(empty.roots).toBeUndefined();
  });

  test("can include all fields", () => {
    const data: RunnerSocketData = {
      runnerId: "r-1",
      runnerName: "My Runner",
      roots: ["/home/user/projects"],
    };
    expect(data.runnerId).toBe("r-1");
    expect(data.runnerName).toBe("My Runner");
    expect(data.roots).toHaveLength(1);
  });

  test("runnerName can be null", () => {
    const data: RunnerSocketData = { runnerId: "r-1", runnerName: null };
    expect(data.runnerName).toBeNull();
  });
});
