import { describe, expect, test } from "bun:test";
import type {
  RelayClientToServerEvents,
  RelayServerToClientEvents,
  RelayInterServerEvents,
  RelaySocketData,
} from "./relay";
import type { Attachment } from "./shared";

// ---------------------------------------------------------------------------
// Relay namespace tests
// Verifies event payload shapes for the /relay namespace (TUI ↔ Server).
// ---------------------------------------------------------------------------

describe("relay — RelayClientToServerEvents payloads", () => {
  test("register carries required cwd with optional fields", () => {
    type Payload = Parameters<RelayClientToServerEvents["register"]>[0];

    const minimal: Payload = { cwd: "/home/user" };
    expect(typeof minimal.cwd).toBe("string");
    expect(minimal.sessionId).toBeUndefined();
    expect(minimal.ephemeral).toBeUndefined();
    expect(minimal.collabMode).toBeUndefined();

    const full: Payload = {
      cwd: "/home/user/project",
      sessionId: "sess-existing",
      ephemeral: true,
      collabMode: true,
      sessionName: "Dev Session",
      parentSessionId: "parent-sess",
    };
    expect(full.sessionId).toBe("sess-existing");
    expect(full.ephemeral).toBe(true);
    expect(full.collabMode).toBe(true);
    expect(full.sessionName).toBe("Dev Session");
    expect(full.parentSessionId).toBe("parent-sess");
  });

  test("register sessionName can be null", () => {
    type Payload = Parameters<RelayClientToServerEvents["register"]>[0];
    const p: Payload = { cwd: "/", sessionName: null };
    expect(p.sessionName).toBeNull();
  });

  test("register parentSessionId can be null", () => {
    type Payload = Parameters<RelayClientToServerEvents["register"]>[0];
    const p: Payload = { cwd: "/", parentSessionId: null };
    expect(p.parentSessionId).toBeNull();
  });

  test("event carries sessionId, token, event with optional seq", () => {
    type Payload = Parameters<RelayClientToServerEvents["event"]>[0];

    const minimal: Payload = {
      sessionId: "sess-1",
      token: "tok-abc",
      event: { type: "heartbeat" },
    };
    expect(typeof minimal.sessionId).toBe("string");
    expect(typeof minimal.token).toBe("string");
    expect(minimal.event).toBeDefined();
    expect(minimal.seq).toBeUndefined();

    const withSeq: Payload = { ...minimal, seq: 42 };
    expect(withSeq.seq).toBe(42);
  });

  test("session_end carries sessionId and token", () => {
    type Payload = Parameters<RelayClientToServerEvents["session_end"]>[0];
    const p: Payload = { sessionId: "sess-1", token: "tok-abc" };
    expect(typeof p.sessionId).toBe("string");
    expect(typeof p.token).toBe("string");
  });

  test("exec_result carries id, ok, command with optional fields", () => {
    type Payload = Parameters<RelayClientToServerEvents["exec_result"]>[0];

    const success: Payload = {
      id: "exec-1",
      ok: true,
      command: "list_sessions",
      result: { sessions: [] },
    };
    expect(success.ok).toBe(true);
    expect(success.error).toBeUndefined();

    const failure: Payload = {
      id: "exec-2",
      ok: false,
      command: "read_file",
      error: "Permission denied",
    };
    expect(failure.ok).toBe(false);
    expect(failure.error).toBe("Permission denied");
    expect(failure.result).toBeUndefined();
  });

  test("session_message carries token, targetSessionId, message", () => {
    type Payload = Parameters<RelayClientToServerEvents["session_message"]>[0];

    const minimal: Payload = {
      token: "tok-1",
      targetSessionId: "sess-target",
      message: "Hello from child",
    };
    expect(typeof minimal.token).toBe("string");
    expect(typeof minimal.targetSessionId).toBe("string");
    expect(typeof minimal.message).toBe("string");
    expect(minimal.deliverAs).toBeUndefined();

    const asInput: Payload = { ...minimal, deliverAs: "input" };
    expect(asInput.deliverAs).toBe("input");
  });

  test("session_trigger carries token and full trigger shape", () => {
    type Payload = Parameters<RelayClientToServerEvents["session_trigger"]>[0];
    const p: Payload = {
      token: "tok-1",
      trigger: {
        type: "plan_review",
        sourceSessionId: "child-sess",
        sourceSessionName: "Child",
        targetSessionId: "parent-sess",
        payload: { plan: "step 1, step 2" },
        deliverAs: "steer",
        expectsResponse: true,
        triggerId: "trig-abc",
        timeoutMs: 30000,
        ts: "2024-01-01T00:00:00Z",
      },
    };

    expect(typeof p.token).toBe("string");
    expect(typeof p.trigger.type).toBe("string");
    expect(typeof p.trigger.triggerId).toBe("string");
    expect(typeof p.trigger.ts).toBe("string");
    expect(p.trigger.deliverAs).toBe("steer");
    expect(p.trigger.expectsResponse).toBe(true);
    expect(p.trigger.sourceSessionName).toBe("Child");
    expect(p.trigger.timeoutMs).toBe(30000);
  });

  test("session_trigger deliverAs can be steer or followUp", () => {
    type TriggerField = Parameters<RelayClientToServerEvents["session_trigger"]>[0]["trigger"];
    const steer: TriggerField = {
      type: "t",
      sourceSessionId: "s",
      targetSessionId: "t",
      payload: {},
      deliverAs: "steer",
      expectsResponse: false,
      triggerId: "id",
      ts: "ts",
    };
    const followUp: TriggerField = { ...steer, deliverAs: "followUp" };
    expect(steer.deliverAs).toBe("steer");
    expect(followUp.deliverAs).toBe("followUp");
  });

  test("trigger_response carries token, triggerId, response, targetSessionId", () => {
    type Payload = Parameters<RelayClientToServerEvents["trigger_response"]>[0];

    const minimal: Payload = {
      token: "tok-1",
      triggerId: "trig-1",
      response: "approved",
      targetSessionId: "child-sess",
    };
    expect(typeof minimal.token).toBe("string");
    expect(typeof minimal.triggerId).toBe("string");
    expect(typeof minimal.response).toBe("string");
    expect(minimal.action).toBeUndefined();

    const withAction: Payload = { ...minimal, action: "approve" };
    expect(withAction.action).toBe("approve");
  });

  test("cleanup_child_session carries token and childSessionId", () => {
    type Payload = Parameters<RelayClientToServerEvents["cleanup_child_session"]>[0];
    const p: Payload = { token: "tok-1", childSessionId: "child-sess" };
    expect(typeof p.token).toBe("string");
    expect(typeof p.childSessionId).toBe("string");
  });

  test("cleanup_child_session ack callback is (result: { ok: boolean; error?: string }) => void", () => {
    // Validates the second parameter (ack) of cleanup_child_session.
    // If ack is removed or its payload shape changes, this fails at compile time.
    type Ack = NonNullable<Parameters<RelayClientToServerEvents["cleanup_child_session"]>[1]>;
    type Result = Parameters<Ack>[0];

    const ack: Ack = (_result) => {};
    expect(typeof ack).toBe("function");

    const ok: Result = { ok: true };
    const fail: Result = { ok: false, error: "Not authorized" };

    expect(ack(ok)).toBeUndefined();
    expect(ack(fail)).toBeUndefined();
  });
});

describe("relay — RelayServerToClientEvents payloads", () => {
  test("registered carries sessionId, token, shareUrl, isEphemeral, collabMode", () => {
    type Payload = Parameters<RelayServerToClientEvents["registered"]>[0];

    const minimal: Payload = {
      sessionId: "sess-1",
      token: "tok-abc",
      shareUrl: "https://example.com/s/sess-1",
      isEphemeral: false,
      collabMode: false,
    };
    expect(typeof minimal.sessionId).toBe("string");
    expect(typeof minimal.token).toBe("string");
    expect(typeof minimal.shareUrl).toBe("string");
    expect(typeof minimal.isEphemeral).toBe("boolean");
    expect(typeof minimal.collabMode).toBe("boolean");
    expect(minimal.parentSessionId).toBeUndefined();

    const withParent: Payload = {
      ...minimal,
      parentSessionId: "parent-sess",
    };
    expect(withParent.parentSessionId).toBe("parent-sess");
  });

  test("registered parentSessionId can be null", () => {
    type Payload = Parameters<RelayServerToClientEvents["registered"]>[0];
    const p: Payload = {
      sessionId: "s",
      token: "t",
      shareUrl: "u",
      isEphemeral: false,
      collabMode: false,
      parentSessionId: null,
    };
    expect(p.parentSessionId).toBeNull();
  });

  test("event_ack carries sessionId and seq", () => {
    type Payload = Parameters<RelayServerToClientEvents["event_ack"]>[0];
    const p: Payload = { sessionId: "sess-1", seq: 100 };
    expect(typeof p.sessionId).toBe("string");
    expect(typeof p.seq).toBe("number");
    expect(p.seq).toBe(100);
  });

  test("connected sends empty record", () => {
    type Payload = Parameters<RelayServerToClientEvents["connected"]>[0];
    const p: Payload = {};
    expect(Object.keys(p)).toHaveLength(0);
  });

  test("input carries text with optional attachments and delivery mode", () => {
    type Payload = Parameters<RelayServerToClientEvents["input"]>[0];

    const minimal: Payload = { text: "Do something useful" };
    expect(typeof minimal.text).toBe("string");
    expect(minimal.attachments).toBeUndefined();
    expect(minimal.deliverAs).toBeUndefined();

    const attachment: Attachment = { attachmentId: "att-1", mediaType: "image/png" };
    const full: Payload = {
      text: "Look at this screenshot",
      attachments: [attachment],
      client: "mobile-web",
      deliverAs: "steer",
    };
    expect(full.attachments).toHaveLength(1);
    expect(full.client).toBe("mobile-web");
    expect(full.deliverAs).toBe("steer");
  });

  test("model_set carries provider and modelId", () => {
    type Payload = Parameters<RelayServerToClientEvents["model_set"]>[0];
    const p: Payload = { provider: "anthropic", modelId: "claude-3-5-sonnet" };
    expect(typeof p.provider).toBe("string");
    expect(typeof p.modelId).toBe("string");
  });

  test("exec carries id and command with extra keys", () => {
    type Payload = Parameters<RelayServerToClientEvents["exec"]>[0];
    const p: Payload = {
      id: "cmd-1",
      command: "new_session",
      cwd: "/tmp",
    };
    expect(typeof p.id).toBe("string");
    expect(typeof p.command).toBe("string");
    expect(p.cwd).toBe("/tmp");
  });

  test("session_message carries fromSessionId, message, ts", () => {
    type Payload = Parameters<RelayServerToClientEvents["session_message"]>[0];
    const p: Payload = {
      fromSessionId: "sess-parent",
      message: "Here is your context",
      ts: "2024-06-01T12:00:00Z",
    };
    expect(typeof p.fromSessionId).toBe("string");
    expect(typeof p.message).toBe("string");
    expect(typeof p.ts).toBe("string");
  });

  test("session_message_error carries targetSessionId and error", () => {
    type Payload = Parameters<RelayServerToClientEvents["session_message_error"]>[0];
    const p: Payload = {
      targetSessionId: "sess-gone",
      error: "Session not found",
    };
    expect(typeof p.targetSessionId).toBe("string");
    expect(typeof p.error).toBe("string");
  });

  test("session_trigger carries a full trigger payload", () => {
    type Payload = Parameters<RelayServerToClientEvents["session_trigger"]>[0];
    const p: Payload = {
      trigger: {
        type: "ask_user_question",
        sourceSessionId: "child-1",
        targetSessionId: "parent-1",
        payload: { question: "What should I do?" },
        deliverAs: "followUp",
        expectsResponse: true,
        triggerId: "trig-xyz",
        ts: "2024-01-01T00:00:00Z",
      },
    };
    expect(p.trigger.type).toBe("ask_user_question");
    expect(p.trigger.expectsResponse).toBe(true);
    expect(p.trigger.deliverAs).toBe("followUp");
    expect(p.trigger.timeoutMs).toBeUndefined();
    expect(p.trigger.sourceSessionName).toBeUndefined();
  });

  test("trigger_response carries triggerId and response with optional metadata", () => {
    type Payload = Parameters<RelayServerToClientEvents["trigger_response"]>[0];

    const minimal: Payload = { triggerId: "trig-1", response: "proceed" };
    expect(typeof minimal.triggerId).toBe("string");
    expect(typeof minimal.response).toBe("string");
    expect(minimal.action).toBeUndefined();
    expect(minimal.targetSessionId).toBeUndefined();

    const withAction: Payload = { ...minimal, action: "followUp" };
    expect(withAction.action).toBe("followUp");

    const withTargetSessionId: Payload = { ...minimal, targetSessionId: "sess-child" };
    expect(withTargetSessionId.targetSessionId).toBe("sess-child");
  });

  test("session_expired carries sessionId", () => {
    type Payload = Parameters<RelayServerToClientEvents["session_expired"]>[0];
    const p: Payload = { sessionId: "sess-expired" };
    expect(typeof p.sessionId).toBe("string");
  });

  test("error carries message", () => {
    type Payload = Parameters<RelayServerToClientEvents["error"]>[0];
    const p: Payload = { message: "Internal relay error" };
    expect(typeof p.message).toBe("string");
  });
});

describe("relay — RelaySocketData", () => {
  test("all fields are optional", () => {
    const empty: RelaySocketData = {};
    expect(empty.sessionId).toBeUndefined();
    expect(empty.token).toBeUndefined();
    expect(empty.cwd).toBeUndefined();
    expect(empty.userId).toBeUndefined();
  });

  test("can include all fields", () => {
    const data: RelaySocketData = {
      sessionId: "sess-1",
      token: "tok-abc",
      cwd: "/home/user",
      userId: "u-42",
    };
    expect(data.sessionId).toBe("sess-1");
    expect(data.token).toBe("tok-abc");
    expect(data.cwd).toBe("/home/user");
    expect(data.userId).toBe("u-42");
  });
});
