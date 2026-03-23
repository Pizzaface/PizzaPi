import { test, expect, describe } from "bun:test";
import { framesFromBuffer, serializeFrame } from "./claude-code-ipc.js";

describe("framesFromBuffer", () => {
  test("parses a single newline-delimited JSON frame", () => {
    const msg = { type: "hook_event", event: "Stop", sessionId: "s1", data: {} };
    const buf = serializeFrame(msg);
    const { frames, remaining } = framesFromBuffer(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(msg);
    expect(remaining).toHaveLength(0);
  });

  test("parses multiple frames from one buffer", () => {
    const a = serializeFrame({ type: "ready", component: "hooks" });
    const b = serializeFrame({ type: "ready", component: "mcp" });
    const { frames } = framesFromBuffer(Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
  });

  test("returns partial frame as remaining when buffer is incomplete", () => {
    const partial = Buffer.from('{"type":"hook_event"');
    const { frames, remaining } = framesFromBuffer(partial);
    expect(frames).toHaveLength(0);
    expect(remaining.toString()).toBe('{"type":"hook_event"');
  });

  test("serializeFrame appends a newline", () => {
    const buf = serializeFrame({ type: "shutdown" });
    expect(buf[buf.length - 1]).toBe(0x0a); // \n
  });
});
