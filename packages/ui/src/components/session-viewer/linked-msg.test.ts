import { expect, test } from "bun:test";
import { parseLinkedSessionMessage } from "./message-item";
test("parse", () => {
  expect(parseLinkedSessionMessage("Message from linked session abc-1:\n\nhi\nthere")).toEqual({ fromSessionId: "abc-1", text: "hi\nthere" });
  expect(parseLinkedSessionMessage([{ type: "text", text: "Message from linked session x:\n\ny" }])?.text).toBe("y");
  expect(parseLinkedSessionMessage("hello")).toBeNull();
});
