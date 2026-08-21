import { describe, expect, test } from "bun:test";
import { parseSessionDeepLink } from "./session-deep-link";

describe("parseSessionDeepLink", () => {
  test("extracts a session id from /session/<id>", () => {
    expect(parseSessionDeepLink("/session/abc-123")).toBe("abc-123");
  });

  test("decodes URL-encoded session ids", () => {
    expect(parseSessionDeepLink("/session/abc%20def")).toBe("abc def");
  });

  test("accepts a trailing slash", () => {
    expect(parseSessionDeepLink("/session/abc-123/")).toBe("abc-123");
  });

  test("rejects the legacy hash route /#/sessions/<id>", () => {
    expect(parseSessionDeepLink("/#/sessions/abc-123")).toBeNull();
  });

  test("returns null for malformed percent-encoding", () => {
    expect(parseSessionDeepLink("/session/%ZZ")).toBeNull();
    expect(parseSessionDeepLink("/session/abc%GH")).toBeNull();
  });

  test("rejects unrelated paths", () => {
    expect(parseSessionDeepLink("/")).toBeNull();
    expect(parseSessionDeepLink("/sessions/abc-123")).toBeNull();
    expect(parseSessionDeepLink("/session/")).toBeNull();
  });
});
