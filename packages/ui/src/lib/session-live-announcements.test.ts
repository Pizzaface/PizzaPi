import { describe, test, expect } from "bun:test";
import { computeLiveAnnouncement } from "./session-live-announcements.js";

describe("computeLiveAnnouncement", () => {
  test("announces disconnect when status goes from Connected to Disconnected", () => {
    expect(computeLiveAnnouncement("Connected", "Disconnected", false, false)).toBe("Disconnected");
  });

  test("announces reconnection when status returns to Connected after a disconnect", () => {
    expect(computeLiveAnnouncement("Disconnected", "Connected", false, false)).toBe("Session reconnected");
  });

  test("does not announce the initial Connecting… -> Connected transition", () => {
    expect(computeLiveAnnouncement("Connecting…", "Connected", false, false)).toBeNull();
  });

  test("announces an error reason surfaced as the status string", () => {
    expect(computeLiveAnnouncement("Connected", "Model not found", false, false)).toBe("Model not found");
  });

  test("announces agent started", () => {
    expect(computeLiveAnnouncement("Connected", "Connected", false, true)).toBe("Agent started");
  });

  test("announces agent stopped", () => {
    expect(computeLiveAnnouncement("Connected", "Connected", true, false)).toBe("Agent stopped");
  });

  test("returns null when nothing meaningful changed", () => {
    expect(computeLiveAnnouncement("Connected", "Connected", true, true)).toBeNull();
  });

  test("ignores transitions between nominal statuses (Idle <-> Connecting…)", () => {
    expect(computeLiveAnnouncement("Idle", "Connecting…", false, false)).toBeNull();
  });
});
