import { describe, expect, test } from "bun:test";
import {
  canSubmitSessionInput,
  getSessionEmptyStateUi,
  isSessionHydrating,
  shouldShowSessionTranscript,
} from "./session-empty-state";

describe("isSessionHydrating", () => {
  test("returns true for connecting statuses", () => {
    expect(isSessionHydrating("Connecting…")).toBe(true);
    expect(isSessionHydrating("connecting...")).toBe(true);
    expect(isSessionHydrating("  Connecting  ")).toBe(true);
  });

  test("returns true for chunked loading statuses", () => {
    expect(isSessionHydrating("Loading session (0 of 120 messages)…")).toBe(true);
    expect(isSessionHydrating("loading session (12 of 120 messages)...")).toBe(true);
  });

  test("returns false for idle waiting/connected states", () => {
    expect(isSessionHydrating("Waiting for session events")).toBe(false);
    expect(isSessionHydrating("Connected")).toBe(false);
    expect(isSessionHydrating("")).toBe(false);
    expect(isSessionHydrating(undefined)).toBe(false);
  });
});

describe("shouldShowSessionTranscript", () => {
  test("hides cached transcript while a session is hydrating", () => {
    expect(shouldShowSessionTranscript("sess-1", "Connecting…", true)).toBe(false);
    expect(shouldShowSessionTranscript("sess-1", "Loading session (0 of 10 messages)…", true)).toBe(false);
  });

  test("shows transcript once the session is connected", () => {
    expect(shouldShowSessionTranscript("sess-1", "Connected", true)).toBe(true);
  });

  test("never shows transcript without a session id or visible messages", () => {
    expect(shouldShowSessionTranscript(null, "Connected", true)).toBe(false);
    expect(shouldShowSessionTranscript("sess-1", "Connected", false)).toBe(false);
  });
});

describe("canSubmitSessionInput", () => {
  test("blocks composer submission while the session is still hydrating", () => {
    expect(canSubmitSessionInput("sess-1", "Connecting…", false)).toBe(false);
    expect(canSubmitSessionInput("sess-1", "Loading session (0 of 10 messages)…", false)).toBe(false);
  });

  test("blocks submission when no session is selected or compaction is active", () => {
    expect(canSubmitSessionInput(null, "Connected", false)).toBe(false);
    expect(canSubmitSessionInput("sess-1", "Connected", true)).toBe(false);
  });

  test("allows submission once the session is connected and interactive", () => {
    expect(canSubmitSessionInput("sess-1", "Connected", false)).toBe(true);
    expect(canSubmitSessionInput("sess-1", "Waiting for session events", false)).toBe(true);
  });
});

describe("getSessionEmptyStateUi", () => {
  test("returns spinning loading state for hydrating statuses", () => {
    expect(getSessionEmptyStateUi("Connecting…")).toEqual({
      title: "Loading session",
      description: "Fetching conversation data…",
      shouldSpinLogo: true,
    });
  });

  test("returns non-spinning waiting state for idle empty sessions", () => {
    expect(getSessionEmptyStateUi("Waiting for session events")).toEqual({
      title: "Waiting for session events",
      description: "Messages will appear here in real time.",
      shouldSpinLogo: false,
    });
  });
});
