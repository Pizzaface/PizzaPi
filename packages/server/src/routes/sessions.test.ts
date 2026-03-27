import { describe, expect, it } from "bun:test";
import { shouldIncludePersistedSessions } from "./sessions.js";

describe("shouldIncludePersistedSessions", () => {
  it("defaults to true", () => {
    expect(shouldIncludePersistedSessions(undefined)).toBe(true);
    expect(shouldIncludePersistedSessions(null)).toBe(true);
    expect(shouldIncludePersistedSessions("")).toBe(true);
  });

  it("treats 0/false/no as false", () => {
    expect(shouldIncludePersistedSessions("0")).toBe(false);
    expect(shouldIncludePersistedSessions("false")).toBe(false);
    expect(shouldIncludePersistedSessions("no")).toBe(false);
    expect(shouldIncludePersistedSessions(" FALSE ")).toBe(false);
  });
});
