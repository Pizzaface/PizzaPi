import { describe, test, expect } from "bun:test";
import { computeLiveAnnouncements, type LiveAnnouncementState } from "./session-live-announcements.js";

function state(status: string | undefined, disconnected: boolean, agentActive = false): LiveAnnouncementState {
  return { status, disconnected, agentActive };
}

describe("computeLiveAnnouncements", () => {
  test("announces disconnect when phase flips to reconnecting/error", () => {
    expect(computeLiveAnnouncements(state("Connected", false), state("Disconnected", true)).assertive).toBe(
      "Disconnected",
    );
  });

  test("announces reconnection when phase returns to connected after a real disconnect", () => {
    expect(computeLiveAnnouncements(state("Disconnected", true), state("Connected", false)).assertive).toBe(
      "Session reconnected",
    );
  });

  test("does not announce the initial Connecting… -> Connected transition", () => {
    expect(computeLiveAnnouncements(state("Connecting…", false), state("Connected", false)).assertive).toBeNull();
  });

  test("announces an error reason surfaced as the status string while disconnected", () => {
    expect(computeLiveAnnouncements(state("Connected", false), state("Model not found", true)).assertive).toBe(
      "Model not found",
    );
  });

  // Real App.tsx sequence: compaction finishes and resets status to
  // "Connected" with no disconnect in between — must NOT announce reconnect.
  test("compaction finishing (Compacting… -> Connected, never disconnected) does not announce reconnect", () => {
    const result = computeLiveAnnouncements(state("Compacting…", false), state("Connected", false));
    expect(result.assertive).toBeNull();
  });

  // Real App.tsx sequence: answering a plan/question resets status to
  // "Connected" with no disconnect in between.
  test("answering a question (Waiting for plan review… -> Connected) does not announce reconnect", () => {
    const result = computeLiveAnnouncements(state("Waiting for plan review…", false), state("Connected", false));
    expect(result.assertive).toBeNull();
  });

  // Real App.tsx sequence: hydration progress ticks while connecting; none
  // of these should ever be assertive.
  test("hydration progress strings are never assertive", () => {
    const steps = ["Connecting…", "Loading session (1 of 10 messages)…", "Loading session (5 of 10 messages)…", "Connected"];
    for (let i = 1; i < steps.length; i++) {
      const result = computeLiveAnnouncements(state(steps[i - 1], false), state(steps[i], false));
      expect(result.assertive).toBeNull();
    }
  });

  // A real disconnect -> reconnect across a CLI restart still announces.
  test("real disconnect then reconnect across a CLI restart is announced both ways", () => {
    const toOffline = computeLiveAnnouncements(state("Connected", false), state("Restarting CLI…", true));
    expect(toOffline.assertive).toBe("Restarting CLI…");
    const toOnline = computeLiveAnnouncements(state("Restarting CLI…", true), state("Connected", false));
    expect(toOnline.assertive).toBe("Session reconnected");
  });

  test("agent started is announced politely, not assertively", () => {
    const result = computeLiveAnnouncements(state("Connected", false, false), state("Connected", false, true));
    expect(result.polite).toBe("Agent started");
    expect(result.assertive).toBeNull();
  });

  test("agent stopped is announced politely", () => {
    const result = computeLiveAnnouncements(state("Connected", false, true), state("Connected", false, false));
    expect(result.polite).toBe("Agent stopped");
    expect(result.assertive).toBeNull();
  });

  test("returns nothing when nothing meaningful changed", () => {
    const result = computeLiveAnnouncements(state("Connected", false, true), state("Connected", false, true));
    expect(result.assertive).toBeNull();
    expect(result.polite).toBeNull();
  });

  test("ignores transitions between nominal statuses (Idle <-> Connecting…)", () => {
    expect(computeLiveAnnouncements(state("Idle", false), state("Connecting…", false)).assertive).toBeNull();
  });

  test("still-offline reason change is announced", () => {
    const result = computeLiveAnnouncements(state("Restarting CLI…", true), state("Connection failed", true));
    expect(result.assertive).toBe("Connection failed");
  });

  // A manual STATUS_SET toast (e.g. the user clicked "Copy") can land while
  // the lifecycle phase is still reconnecting/error. That must never be
  // read as a changed disconnect reason.
  test("a status override toast while still offline is not announced as a reason change", () => {
    const prev: LiveAnnouncementState = { status: "Restarting CLI…", disconnected: true, agentActive: false };
    const next: LiveAnnouncementState = {
      status: "Copied",
      disconnected: true,
      agentActive: false,
      statusIsOverride: true,
    };
    expect(computeLiveAnnouncements(prev, next).assertive).toBeNull();
  });

  // A real reason change (not an override) while still offline is still announced.
  test("a non-override reason change while still offline is still announced", () => {
    const prev: LiveAnnouncementState = { status: "Restarting CLI…", disconnected: true, agentActive: false };
    const next: LiveAnnouncementState = {
      status: "Connection failed",
      disconnected: true,
      agentActive: false,
      statusIsOverride: false,
    };
    expect(computeLiveAnnouncements(prev, next).assertive).toBe("Connection failed");
  });
});
