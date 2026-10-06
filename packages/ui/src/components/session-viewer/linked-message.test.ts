import { describe, expect, test } from "bun:test";
import { LINKED_SESSION_MESSAGE_TYPE } from "@pizzapi/protocol";
import { getLinkedSessionMessage } from "./message-item";

describe("getLinkedSessionMessage", () => {
  test("reads structured details from the linked-session custom message", () => {
    expect(getLinkedSessionMessage({
      role: "custom",
      customType: LINKED_SESSION_MESSAGE_TYPE,
      details: { fromSessionId: "abc-123", message: "Ack.\n\nline two" },
    })).toEqual({ fromSessionId: "abc-123", message: "Ack.\n\nline two" });
  });
  test("ignores user text that merely looks like a linked message", () => {
    expect(getLinkedSessionMessage({ role: "user" })).toBeNull();
    expect(getLinkedSessionMessage({ role: "custom", customType: "other", details: { fromSessionId: "x", message: "y" } })).toBeNull();
    expect(getLinkedSessionMessage({ role: "custom", customType: LINKED_SESSION_MESSAGE_TYPE, details: {} })).toBeNull();
  });
});
