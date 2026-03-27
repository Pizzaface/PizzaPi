import { test, expect, describe } from "bun:test";
import { parsePermissionRequest } from "./permission-request.js";

describe("parsePermissionRequest", () => {
  test("parses a valid permission_request event", () => {
    const event = {
      type: "permission_request",
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "rm -rf /tmp/build" },
      ts: 1234567890,
    };
    const result = parsePermissionRequest(event);
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("req-1");
    expect(result!.toolName).toBe("Bash");
    expect(result!.toolInput).toEqual({ command: "rm -rf /tmp/build" });
  });

  test("returns null for non-permission_request events", () => {
    expect(parsePermissionRequest({ type: "heartbeat" })).toBeNull();
    expect(parsePermissionRequest(null)).toBeNull();
    expect(parsePermissionRequest(undefined)).toBeNull();
  });

  test("returns null when requestId is missing", () => {
    expect(parsePermissionRequest({ type: "permission_request", toolName: "Bash", toolInput: {} })).toBeNull();
  });
});
