import { describe, expect, test } from "bun:test";
import type {
  ViewerServerToClientEvents,
  ViewerClientToServerEvents,
  ViewerInterServerEvents,
  ViewerSocketData,
} from "./viewer";
import type { Attachment } from "./shared";

// ---------------------------------------------------------------------------
// Viewer namespace tests
// Verifies event payload shapes for the /viewer namespace.
// ---------------------------------------------------------------------------

describe("viewer — ViewerServerToClientEvents payloads", () => {
  test("connected carries sessionId with optional fields", () => {
    type Payload = Parameters<ViewerServerToClientEvents["connected"]>[0];

    const minimal: Payload = { sessionId: "sess-1" };
    expect(typeof minimal.sessionId).toBe("string");
    expect(minimal.lastSeq).toBeUndefined();
    expect(minimal.replayOnly).toBeUndefined();
    expect(minimal.isActive).toBeUndefined();

    const full: Payload = {
      sessionId: "sess-2",
      lastSeq: 42,
      replayOnly: true,
      isActive: false,
      lastHeartbeatAt: null,
      sessionName: "My Session",
    };
    expect(full.lastSeq).toBe(42);
    expect(full.replayOnly).toBe(true);
    expect(full.sessionName).toBe("My Session");
  });

  test("event payload carries event with optional seq and replay", () => {
    type Payload = Parameters<ViewerServerToClientEvents["event"]>[0];

    const minimal: Payload = { event: { type: "heartbeat" } };
    expect(minimal.event).toBeDefined();
    expect(minimal.seq).toBeUndefined();
    expect(minimal.replay).toBeUndefined();

    const full: Payload = {
      event: { type: "message_update", content: "Hello" },
      seq: 100,
      replay: true,
    };
    expect(full.seq).toBe(100);
    expect(full.replay).toBe(true);
  });

  test("disconnected carries reason string with optional structured code", () => {
    type Payload = Parameters<ViewerServerToClientEvents["disconnected"]>[0];
    const p: Payload = { reason: "TUI disconnected" };
    expect(typeof p.reason).toBe("string");
    expect(p.code).toBeUndefined();

    const structured: Payload = { reason: "Session is no longer live (snapshot replay).", code: "snapshot_replay" };
    expect(structured.code).toBe("snapshot_replay");
  });

  test("exec_result carries id, ok, and command", () => {
    type Payload = Parameters<ViewerServerToClientEvents["exec_result"]>[0];

    const success: Payload = {
      id: "exec-1",
      ok: true,
      command: "list_sessions",
      result: { sessions: [] },
    };
    expect(success.ok).toBe(true);
    expect(typeof success.id).toBe("string");
    expect(typeof success.command).toBe("string");
    expect(success.error).toBeUndefined();

    const failure: Payload = {
      id: "exec-2",
      ok: false,
      command: "read_file",
      error: "File not found",
    };
    expect(failure.ok).toBe(false);
    expect(failure.error).toBe("File not found");
    expect(failure.result).toBeUndefined();
  });

  test("error carries message string", () => {
    type Payload = Parameters<ViewerServerToClientEvents["error"]>[0];
    const p: Payload = { message: "Unauthorized" };
    expect(typeof p.message).toBe("string");
  });

  test("trigger_error carries message and triggerId", () => {
    type Payload = Parameters<ViewerServerToClientEvents["trigger_error"]>[0];
    const p: Payload = {
      message: "Child session is no longer available",
      triggerId: "trig-abc123",
    };
    expect(typeof p.message).toBe("string");
    expect(typeof p.triggerId).toBe("string");
  });
});

describe("viewer — ViewerClientToServerEvents payloads", () => {
  test("connected sends empty record", () => {
    type Payload = Parameters<ViewerClientToServerEvents["connected"]>[0];
    const p: Payload = {};
    expect(Object.keys(p)).toHaveLength(0);
  });

  test("resync sends empty record", () => {
    type Payload = Parameters<ViewerClientToServerEvents["resync"]>[0];
    const p: Payload = {};
    expect(Object.keys(p)).toHaveLength(0);
  });

  test("input carries text with optional fields", () => {
    type Payload = Parameters<ViewerClientToServerEvents["input"]>[0];

    const minimal: Payload = { text: "Hello agent" };
    expect(typeof minimal.text).toBe("string");
    expect(minimal.attachments).toBeUndefined();
    expect(minimal.client).toBeUndefined();
    expect(minimal.deliverAs).toBeUndefined();

    const attachment: Attachment = {
      attachmentId: "att-1",
      mediaType: "image/png",
      filename: "shot.png",
    };
    const full: Payload = {
      text: "Look at this",
      attachments: [attachment],
      client: "web",
      deliverAs: "followUp",
    };
    expect(full.attachments).toHaveLength(1);
    expect(full.client).toBe("web");
    expect(full.deliverAs).toBe("followUp");
  });

  test("input deliverAs can be 'steer' or 'followUp'", () => {
    type Payload = Parameters<ViewerClientToServerEvents["input"]>[0];
    const steer: Payload = { text: "steer me", deliverAs: "steer" };
    const followUp: Payload = { text: "follow up", deliverAs: "followUp" };
    expect(steer.deliverAs).toBe("steer");
    expect(followUp.deliverAs).toBe("followUp");
  });

  test("model_set carries provider and modelId", () => {
    type Payload = Parameters<ViewerClientToServerEvents["model_set"]>[0];
    const p: Payload = { provider: "anthropic", modelId: "claude-opus-4" };
    expect(typeof p.provider).toBe("string");
    expect(typeof p.modelId).toBe("string");
  });

  test("exec carries id and command with extra keys", () => {
    type Payload = Parameters<ViewerClientToServerEvents["exec"]>[0];
    const p: Payload = {
      id: "cmd-1",
      command: "list_sessions",
      extraParam: true,
    };
    expect(typeof p.id).toBe("string");
    expect(typeof p.command).toBe("string");
    expect(p.extraParam).toBe(true);
  });

  test("trigger_response carries triggerId, response, targetSessionId", () => {
    type Payload = Parameters<ViewerClientToServerEvents["trigger_response"]>[0];
    const p: Payload = {
      triggerId: "trig-1",
      response: "approve",
      targetSessionId: "sess-child",
    };
    expect(typeof p.triggerId).toBe("string");
    expect(typeof p.response).toBe("string");
    expect(typeof p.targetSessionId).toBe("string");
    expect(p.action).toBeUndefined();
  });

  test("trigger_response can include optional action", () => {
    type Payload = Parameters<ViewerClientToServerEvents["trigger_response"]>[0];
    const p: Payload = {
      triggerId: "trig-2",
      response: "LGTM",
      targetSessionId: "sess-child",
      action: "approve",
    };
    expect(p.action).toBe("approve");
  });

  test("trigger_response ack callback is a no-arg void function", () => {
    // Validates the second parameter (ack) of trigger_response is () => void.
    // The UI waits for this ack before marking a trigger as delivered; the
    // server only calls it on successful delivery.  If the signature changes
    // (e.g. ack removed or gains parameters) this test will fail at compile time.
    type Ack = Parameters<ViewerClientToServerEvents["trigger_response"]>[1];
    const ack: Ack = () => {};
    expect(typeof ack).toBe("function");
    // calling it should return undefined (void)
    expect(ack()).toBeUndefined();
  });
});

describe("viewer — ViewerSocketData", () => {
  test("all fields are optional", () => {
    const empty: ViewerSocketData = {};
    expect(empty.sessionId).toBeUndefined();
    expect(empty.userId).toBeUndefined();
    expect(empty.userName).toBeUndefined();
  });

  test("can include all fields", () => {
    const data: ViewerSocketData = {
      sessionId: "sess-1",
      userId: "u-42",
      userName: "alice",
    };
    expect(data.sessionId).toBe("sess-1");
    expect(data.userId).toBe("u-42");
    expect(data.userName).toBe("alice");
  });
});
