import { describe, expect, test } from "bun:test";
import type {
  HubServerToClientEvents,
  HubClientToServerEvents,
  HubInterServerEvents,
  HubSocketData,
} from "./hub";
import type { SessionInfo, ModelInfo } from "./shared";

// ---------------------------------------------------------------------------
// Hub namespace tests
// Verifies event payload shapes for the /hub namespace (read-only session feed).
// ---------------------------------------------------------------------------

describe("hub — HubServerToClientEvents payloads", () => {
  const baseSession: SessionInfo = {
    sessionId: "s1",
    shareUrl: "https://example.com/s/s1",
    cwd: "/tmp",
    startedAt: "2024-01-01T00:00:00Z",
    sessionName: "Test Session",
    isEphemeral: false,
    isActive: true,
    lastHeartbeatAt: "2024-01-01T00:01:00Z",
    model: { provider: "anthropic", id: "claude-opus-4" },
    runnerId: "r1",
    runnerName: "Dev Runner",
  };

  test("sessions event carries a sessions array", () => {
    // Simulate the payload shape for the 'sessions' event
    type SessionsPayload = Parameters<HubServerToClientEvents["sessions"]>[0];
    const payload: SessionsPayload = {
      sessions: [baseSession],
    };
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(payload.sessions[0].sessionId).toBe("s1");
  });

  test("session_added event carries full SessionInfo", () => {
    type AddedPayload = Parameters<HubServerToClientEvents["session_added"]>[0];
    const payload: AddedPayload = baseSession;
    expect(typeof payload.sessionId).toBe("string");
    expect(typeof payload.isActive).toBe("boolean");
  });

  test("session_removed event carries sessionId", () => {
    type RemovedPayload = Parameters<HubServerToClientEvents["session_removed"]>[0];
    const payload: RemovedPayload = { sessionId: "s1" };
    expect(typeof payload.sessionId).toBe("string");
  });

  test("session_status event carries status update fields", () => {
    type StatusPayload = Parameters<HubServerToClientEvents["session_status"]>[0];
    const payload: StatusPayload = {
      sessionId: "s1",
      isActive: false,
      lastHeartbeatAt: null,
      sessionName: "Updated Name",
      model: null,
    };
    expect(typeof payload.sessionId).toBe("string");
    expect(typeof payload.isActive).toBe("boolean");
    expect(payload.lastHeartbeatAt).toBeNull();
    expect(payload.model).toBeNull();
  });

  test("session_status event can include runnerId and runnerName", () => {
    type StatusPayload = Parameters<HubServerToClientEvents["session_status"]>[0];
    const payload: StatusPayload = {
      sessionId: "s2",
      isActive: true,
      lastHeartbeatAt: "2024-06-01T00:00:00Z",
      sessionName: null,
      model: { provider: "google", id: "gemini-2.5-pro" } satisfies ModelInfo,
      runnerId: "r2",
      runnerName: "Remote Runner",
    };
    expect(payload.runnerId).toBe("r2");
    expect(payload.runnerName).toBe("Remote Runner");
  });

  test("sessions event with empty list is valid", () => {
    type SessionsPayload = Parameters<HubServerToClientEvents["sessions"]>[0];
    const payload: SessionsPayload = { sessions: [] };
    expect(payload.sessions).toHaveLength(0);
  });
});

describe("hub — HubClientToServerEvents (read-only, no events)", () => {
  test("HubClientToServerEvents has no event keys", () => {
    // The hub is read-only — clients emit nothing.
    // We verify via TypeScript that the interface is empty.
    const events: HubClientToServerEvents = {};
    expect(Object.keys(events)).toHaveLength(0);
  });
});

describe("hub — HubSocketData", () => {
  test("userId is optional", () => {
    const noUser: HubSocketData = {};
    const withUser: HubSocketData = { userId: "u-42" };

    expect(noUser.userId).toBeUndefined();
    expect(withUser.userId).toBe("u-42");
  });
});
