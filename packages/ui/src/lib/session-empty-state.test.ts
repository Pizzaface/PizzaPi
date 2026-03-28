import { describe, expect, test } from "bun:test";
import { getSessionEmptyStateUi, isSessionHydrating } from "./session-empty-state";

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
