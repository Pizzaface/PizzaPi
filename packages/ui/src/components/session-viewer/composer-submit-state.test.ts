import { describe, expect, test } from "bun:test";
import { getComposerSubmitMode } from "./composer-submit-state";

describe("getComposerSubmitMode", () => {
  test("hides send on mobile when idle", () => {
    expect(
      getComposerSubmitMode({
        isTouchDevice: true,
        agentActive: false,
        hasDraft: false,
        canAbort: false,
      }),
    ).toBe("hidden");
  });

  test("shows send on mobile once draft exists", () => {
    expect(
      getComposerSubmitMode({
        isTouchDevice: true,
        agentActive: false,
        hasDraft: true,
        canAbort: false,
      }),
    ).toBe("send");
  });

  test("shows stop on mobile while streaming with no draft", () => {
    expect(
      getComposerSubmitMode({
        isTouchDevice: true,
        agentActive: true,
        hasDraft: false,
        canAbort: true,
      }),
    ).toBe("stop");
  });

  test("shows send on mobile while streaming when composing follow-up", () => {
    expect(
      getComposerSubmitMode({
        isTouchDevice: true,
        agentActive: true,
        hasDraft: true,
        canAbort: true,
      }),
    ).toBe("send");
  });

  test("desktop keeps send visible when idle", () => {
    expect(
      getComposerSubmitMode({
        isTouchDevice: false,
        agentActive: false,
        hasDraft: false,
        canAbort: false,
      }),
    ).toBe("send");
  });

  test("desktop uses stop while streaming", () => {
    expect(
      getComposerSubmitMode({
        isTouchDevice: false,
        agentActive: true,
        hasDraft: false,
        canAbort: true,
      }),
    ).toBe("stop");
  });
});
