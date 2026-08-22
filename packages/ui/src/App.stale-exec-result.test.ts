import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Guard: exec_result events from a previous session must be dropped when
 * the viewer has already switched to a new session.
 *
 * The relay stamps exec_result with the originating sessionId; App.tsx must
 * reject any event whose sessionId != the currently-active session.
 */
describe("App stale exec_result session guard", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  // Find the exec_result socket handler block.
  const execResultBlock = (() => {
    const start = src.indexOf('nextSocket.on("exec_result"');
    const end = src.indexOf("});", start) + 3;
    return src.slice(start, end);
  })();

  test("handler rejects exec_result when sessionId mismatches active session", () => {
    // The guard must compare data.sessionId against the active session ref.
    expect(execResultBlock).toMatch(/data\.sessionId.*!==.*activeSessionId/);
  });

  test("handler allows exec_result without sessionId (old relay compat)", () => {
    // The guard must be conditional so legacy payloads (no sessionId) still pass.
    // Pattern: `if (data.sessionId && data.sessionId !== ...)` — short-circuits on falsy.
    expect(execResultBlock).toMatch(/data\.sessionId &&/);
  });

  test("handler still guards on awaitingSnapshot", () => {
    expect(execResultBlock).toMatch(/awaitingSnapshot/);
  });
});
