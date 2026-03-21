import { describe, expect, test } from "bun:test";
import type {
  TerminalServerToClientEvents,
  TerminalClientToServerEvents,
  TerminalInterServerEvents,
  TerminalSocketData,
} from "./terminal";

// ---------------------------------------------------------------------------
// Terminal namespace tests
// Verifies event payload shapes for the /terminal namespace.
// ---------------------------------------------------------------------------

describe("terminal — TerminalServerToClientEvents payloads", () => {
  test("terminal_connected carries terminalId", () => {
    type Payload = Parameters<TerminalServerToClientEvents["terminal_connected"]>[0];
    const p: Payload = { terminalId: "term-1" };
    expect(typeof p.terminalId).toBe("string");
  });

  test("terminal_ready carries terminalId", () => {
    type Payload = Parameters<TerminalServerToClientEvents["terminal_ready"]>[0];
    const p: Payload = { terminalId: "term-2" };
    expect(typeof p.terminalId).toBe("string");
    expect(p.terminalId).toBe("term-2");
  });

  test("terminal_data carries terminalId and data string", () => {
    type Payload = Parameters<TerminalServerToClientEvents["terminal_data"]>[0];
    const p: Payload = { terminalId: "term-3", data: "\x1b[32mHello\x1b[0m" };
    expect(typeof p.terminalId).toBe("string");
    expect(typeof p.data).toBe("string");
  });

  test("terminal_exit carries terminalId and exitCode", () => {
    type Payload = Parameters<TerminalServerToClientEvents["terminal_exit"]>[0];
    const success: Payload = { terminalId: "term-4", exitCode: 0 };
    const failure: Payload = { terminalId: "term-5", exitCode: 1 };
    expect(success.exitCode).toBe(0);
    expect(failure.exitCode).toBe(1);
    expect(typeof success.terminalId).toBe("string");
  });

  test("terminal_error carries terminalId and message", () => {
    type Payload = Parameters<TerminalServerToClientEvents["terminal_error"]>[0];
    const p: Payload = { terminalId: "term-6", message: "PTY spawn failed" };
    expect(typeof p.terminalId).toBe("string");
    expect(typeof p.message).toBe("string");
    expect(p.message).toBe("PTY spawn failed");
  });
});

describe("terminal — TerminalClientToServerEvents payloads", () => {
  test("terminal_input carries terminalId and data", () => {
    type Payload = Parameters<TerminalClientToServerEvents["terminal_input"]>[0];
    const p: Payload = { terminalId: "term-1", data: "ls -la\r" };
    expect(typeof p.terminalId).toBe("string");
    expect(typeof p.data).toBe("string");
  });

  test("terminal_resize carries terminalId, cols, and rows", () => {
    type Payload = Parameters<TerminalClientToServerEvents["terminal_resize"]>[0];
    const p: Payload = { terminalId: "term-1", cols: 220, rows: 50 };
    expect(typeof p.cols).toBe("number");
    expect(typeof p.rows).toBe("number");
    expect(p.cols).toBe(220);
    expect(p.rows).toBe(50);
  });

  test("kill_terminal carries terminalId", () => {
    type Payload = Parameters<TerminalClientToServerEvents["kill_terminal"]>[0];
    const p: Payload = { terminalId: "term-9" };
    expect(typeof p.terminalId).toBe("string");
  });
});

describe("terminal — TerminalSocketData", () => {
  test("all fields are optional", () => {
    const empty: TerminalSocketData = {};
    expect(empty.terminalId).toBeUndefined();
    expect(empty.userId).toBeUndefined();
  });

  test("can include terminalId and userId", () => {
    const data: TerminalSocketData = { terminalId: "t1", userId: "u1" };
    expect(data.terminalId).toBe("t1");
    expect(data.userId).toBe("u1");
  });
});
