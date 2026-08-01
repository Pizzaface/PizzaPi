import { describe, expect, test } from "bun:test";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleActions as a,
  sessionLifecycleReducer,
  isSessionHydratingState,
  isSessionLiveState,
  canSubmitSessionInputState,
  getSessionEmptyState,
} from "./session-lifecycle";

describe("session lifecycle reducer", () => {
  const initial = createInitialSessionLifecycleState;

  test("initial state is idle", () => {
    const state = initial();
    expect(state.phase).toBe("idle");
    expect(state.status).toBe("Idle");
    expect(state.error).toBeNull();
    expect(state.activeSessionId).toBeNull();
  });

  describe("spawn flow", () => {
    test("spawnRequested transitions to spawning", () => {
      const state = sessionLifecycleReducer(initial(), a.spawnRequested("runner-1", "/tmp/foo"));
      expect(state.phase).toBe("spawning");
      expect(state.status).toBe("Spawning session…");
      expect(state.spawn.runnerId).toBe("runner-1");
      expect(state.spawn.cwd).toBe("/tmp/foo");
      expect(state.error).toBeNull();
    });

    test("spawnRequested preserves form fields", () => {
      const state = sessionLifecycleReducer(initial(), a.spawnRequested(undefined, undefined));
      expect(state.spawn.runnerId).toBeUndefined();
      expect(state.spawn.cwd).toBe("");
    });

    test("spawnSucceeded moves from spawning to registering", () => {
      const spawning = sessionLifecycleReducer(initial(), a.spawnRequested("runner-1", "/tmp/foo"));
      const state = sessionLifecycleReducer(spawning, a.spawnSucceeded("session-abc"));
      expect(state.phase).toBe("registering");
      expect(state.status).toBe("Session is starting…");
      expect(state.spawn.pendingSessionId).toBe("session-abc");
    });

    test("spawnSucceeded is a no-op outside spawning", () => {
      const state = sessionLifecycleReducer(initial(), a.spawnSucceeded("session-abc"));
      expect(state.phase).toBe("idle");
    });

    test("spawnFailed records error and stays retryable", () => {
      const spawning = sessionLifecycleReducer(initial(), a.spawnRequested("runner-1", "/tmp/foo"));
      const state = sessionLifecycleReducer(spawning, a.spawnFailed("No runners connected"));
      expect(state.phase).toBe("error");
      expect(state.status).toBe("No runners connected");
      expect(state.error).toBe("No runners connected");
      expect(state.spawn.error).toBe("No runners connected");
      // Form fields are preserved so the user can retry.
      expect(state.spawn.runnerId).toBe("runner-1");
      expect(state.spawn.cwd).toBe("/tmp/foo");
    });

    test("spawnFailed keeps the wizard state available for retry", () => {
      const state = sessionLifecycleReducer(initial(), a.spawnFailed("timeout"));
      expect(state.spawn.runnerId).toBeUndefined();
      expect(state.spawn.cwd).toBe("");
    });
  });

  describe("session selection", () => {
    test("sessionSelected moves to connecting and resets hydration", () => {
      const previous = sessionLifecycleReducer(
        initial(),
        a.spawnRequested("runner-1", "/tmp/foo"),
      );
      const state = sessionLifecycleReducer(previous, a.sessionSelected("session-abc"));
      expect(state.phase).toBe("connecting");
      expect(state.status).toBe("Connecting…");
      expect(state.activeSessionId).toBe("session-abc");
      expect(state.hydration.awaitingSnapshot).toBe(true);
      expect(state.hydration.hydrated).toBe(false);
      expect(state.generation).toBeGreaterThan(0);
    });

    test("sessionSelected preserves spawn form fields", () => {
      const previous = sessionLifecycleReducer(
        initial(),
        a.spawnParamsChanged({ runnerId: "runner-2", cwd: "/tmp/bar", preselectedRunnerId: "runner-2" }),
      );
      const state = sessionLifecycleReducer(previous, a.sessionSelected("session-abc"));
      expect(state.spawn.runnerId).toBe("runner-2");
      expect(state.spawn.cwd).toBe("/tmp/bar");
      expect(state.spawn.preselectedRunnerId).toBe("runner-2");
    });
  });

  describe("connection", () => {
    test("connected on a fresh session marks awaiting snapshot", () => {
      const selected = sessionLifecycleReducer(initial(), a.sessionSelected("session-abc"));
      const state = sessionLifecycleReducer(selected, a.connected({}));
      expect(state.phase).toBe("connecting");
      expect(state.status).toBe("Connected");
      expect(state.hydration.awaitingSnapshot).toBe(true);
      expect(state.hydration.hydrated).toBe(false);
    });

    test("connected with replayOnly goes straight to snapshot_replay", () => {
      const selected = sessionLifecycleReducer(initial(), a.sessionSelected("session-abc"));
      const state = sessionLifecycleReducer(selected, a.connected({ replayOnly: true }));
      expect(state.phase).toBe("snapshot_replay");
      expect(state.status).toBe("Snapshot replay");
      expect(state.hydration.awaitingSnapshot).toBe(false);
      expect(state.hydration.hydrated).toBe(true);
    });

    test("connected without active session is a no-op", () => {
      const state = sessionLifecycleReducer(initial(), a.connected({}));
      expect(state.phase).toBe("idle");
    });

    test("connected marks hub meta source", () => {
      const selected = sessionLifecycleReducer(initial(), a.sessionSelected("session-abc"));
      const state = sessionLifecycleReducer(selected, a.connected({ metaSource: "hub" }));
      expect(state.hydration.metaSourceHub).toBe(true);
    });
  });

  describe("snapshot hydration", () => {
    test("snapshotStarted (non-chunked) clears awaiting-snapshot flag", () => {
      const connected = sessionLifecycleReducer(
        sessionLifecycleReducer(initial(), a.sessionSelected("session-abc")),
        a.connected({}),
      );
      const state = sessionLifecycleReducer(connected, a.snapshotStarted({}));
      expect(state.phase).toBe("connecting");
      expect(state.status).toBe("Connected");
      expect(state.hydration.awaitingSnapshot).toBe(false);
      expect(state.hydration.hydrated).toBe(false);
      expect(state.hydration.lastCompletedSnapshot).toBe("non-chunked");
    });

    test("snapshotStarted (chunked) sets up chunk tracking", () => {
      const connected = sessionLifecycleReducer(
        sessionLifecycleReducer(initial(), a.sessionSelected("session-abc")),
        a.connected({}),
      );
      const state = sessionLifecycleReducer(
        connected,
        a.snapshotStarted({ chunked: true, snapshotId: "snap-1", totalMessages: 100 }),
      );
      expect(state.phase).toBe("connecting");
      expect(state.status).toBe("Loading session (0 of 100 messages)…");
      expect(state.hydration.chunked).not.toBeNull();
      expect(state.hydration.chunked?.snapshotId).toBe("snap-1");
      expect(state.hydration.chunked?.totalMessages).toBe(100);
    });

    test("chunkReceived updates progress", () => {
      const connected = sessionLifecycleReducer(
        sessionLifecycleReducer(initial(), a.sessionSelected("session-abc")),
        a.connected({}),
      );
      const chunked = sessionLifecycleReducer(
        connected,
        a.snapshotStarted({ chunked: true, snapshotId: "snap-1", totalMessages: 100 }),
      );
      const state = sessionLifecycleReducer(chunked, a.chunkReceived(40, 100));
      expect(state.status).toBe("Loading session (40 of 100 messages)…");
      expect(state.hydration.chunked?.loadedMessages).toBe(40);
    });

    test("chunkReceived without chunked state is a no-op", () => {
      const connected = sessionLifecycleReducer(
        sessionLifecycleReducer(initial(), a.sessionSelected("session-abc")),
        a.connected({}),
      );
      const state = sessionLifecycleReducer(connected, a.chunkReceived(10, 100));
      expect(state.status).toBe("Connected");
    });

    test("snapshotComplete moves to live", () => {
      const connected = sessionLifecycleReducer(
        sessionLifecycleReducer(initial(), a.sessionSelected("session-abc")),
        a.connected({}),
      );
      const started = sessionLifecycleReducer(connected, a.snapshotStarted({}));
      const state = sessionLifecycleReducer(started, a.snapshotComplete());
      expect(state.phase).toBe("live");
      expect(state.status).toBe("Connected");
      expect(state.hydration.hydrated).toBe(true);
      expect(state.hydration.awaitingSnapshot).toBe(false);
    });

    test("snapshotComplete preserves transient statuses", () => {
      const started = sessionLifecycleReducer(
        sessionLifecycleReducer(
          sessionLifecycleReducer(initial(), a.sessionSelected("session-abc")),
          a.connected({}),
        ),
        a.snapshotStarted({}),
      );
      const compacting = sessionLifecycleReducer(started, a.statusSet("Compacting…"));
      const state = sessionLifecycleReducer(compacting, a.snapshotComplete());
      expect(state.phase).toBe("live");
      expect(state.status).toBe("Compacting…");
    });

    test("snapshotComplete without active session is a no-op", () => {
      const state = sessionLifecycleReducer(initial(), a.snapshotComplete());
      expect(state.phase).toBe("idle");
    });
  });

  describe("disconnection and reconnect", () => {
    test("disconnected while live stops reconnect if requested", () => {
      const live = goLive("session-abc");
      const state = sessionLifecycleReducer(
        live,
        a.disconnected({ reason: "Session ended", stopReconnect: true }),
      );
      expect(state.phase).toBe("error");
      expect(state.status).toBe("Session ended");
      expect(state.error).toBe("Session ended");
    });

    test("disconnected for CLI restart transitions to reconnecting", () => {
      const live = goLive("session-abc");
      const state = sessionLifecycleReducer(
        live,
        a.disconnected({ reason: "Session reconnected", isRestarting: true }),
      );
      expect(state.phase).toBe("reconnecting");
      expect(state.status).toBe("Restarting CLI…");
      expect(state.error).toBeNull();
      expect(state.reconnect.restartPendingSessionId).toBe("session-abc");
    });

    test("disconnected for transient reason becomes error", () => {
      const live = goLive("session-abc");
      const state = sessionLifecycleReducer(
        live,
        a.disconnected({ reason: "Transport error" }),
      );
      expect(state.phase).toBe("error");
      expect(state.status).toBe("Transport error");
      expect(state.error).toBe("Transport error");
    });

    test("disconnected without active session is a no-op", () => {
      const state = sessionLifecycleReducer(
        initial(),
        a.disconnected({ reason: "x" }),
      );
      expect(state.phase).toBe("idle");
    });

    test("reconnecting action transitions back to reconnecting", () => {
      const live = goLive("session-abc");
      const disconnected = sessionLifecycleReducer(
        live,
        a.disconnected({ reason: "Session reconnected", isRestarting: true }),
      );
      const state = sessionLifecycleReducer(disconnected, a.reconnecting());
      expect(state.phase).toBe("reconnecting");
      expect(state.status).toBe("Restarting CLI…");
    });
  });

  describe("error handling", () => {
    test("error action moves to error phase", () => {
      const state = sessionLifecycleReducer(initial(), a.error("Viewer socket failed"));
      expect(state.phase).toBe("error");
      expect(state.status).toBe("Viewer socket failed");
      expect(state.error).toBe("Viewer socket failed");
    });
  });

  describe("clearing", () => {
    test("cleared resets to idle and wipes session identity", () => {
      const live = goLive("session-abc");
      const state = sessionLifecycleReducer(live, a.cleared());
      expect(state.phase).toBe("idle");
      expect(state.activeSessionId).toBeNull();
      expect(state.hydration.hydrated).toBe(false);
      expect(state.error).toBeNull();
    });

    test("cleared keeps spawn form fields", () => {
      const live = sessionLifecycleReducer(
        sessionLifecycleReducer(
          initial(),
          a.spawnParamsChanged({ runnerId: "runner-1", cwd: "/tmp/foo" }),
        ),
        a.sessionSelected("session-abc"),
      );
      const cleared = sessionLifecycleReducer(live, a.cleared());
      expect(cleared.spawn.runnerId).toBe("runner-1");
      expect(cleared.spawn.cwd).toBe("/tmp/foo");
    });
  });

  describe("selectors", () => {
    test("isSessionHydratingState is true during connecting", () => {
      const connecting = sessionLifecycleReducer(initial(), a.sessionSelected("s"));
      expect(isSessionHydratingState(connecting)).toBe(true);
    });

    test("isSessionLiveState is true only for live and snapshot_replay", () => {
      const live = goLive("s");
      expect(isSessionLiveState(live)).toBe(true);

      const replay = sessionLifecycleReducer(
        sessionLifecycleReducer(initial(), a.sessionSelected("s")),
        a.connected({ replayOnly: true }),
      );
      expect(isSessionLiveState(replay)).toBe(true);

      const connecting = sessionLifecycleReducer(initial(), a.sessionSelected("s"));
      expect(isSessionLiveState(connecting)).toBe(false);
    });

    test("canSubmitSessionInputState requires live phase", () => {
      const live = goLive("s");
      expect(canSubmitSessionInputState(live)).toBe(true);

      const connecting = sessionLifecycleReducer(initial(), a.sessionSelected("s"));
      expect(canSubmitSessionInputState(connecting)).toBe(false);
    });

    test("getSessionEmptyState reflects hydration", () => {
      const connecting = sessionLifecycleReducer(initial(), a.sessionSelected("s"));
      expect(getSessionEmptyState(connecting).shouldSpinLogo).toBe(true);

      const live = goLive("s");
      expect(getSessionEmptyState(live).shouldSpinLogo).toBe(false);
    });
  });
});

function goLive(sessionId: string) {
  return sessionLifecycleReducer(
    sessionLifecycleReducer(
      sessionLifecycleReducer(
        sessionLifecycleReducer(createInitialSessionLifecycleState(), a.sessionSelected(sessionId)),
        a.connected({}),
      ),
      a.snapshotStarted({}),
    ),
    a.snapshotComplete(),
  );
}
