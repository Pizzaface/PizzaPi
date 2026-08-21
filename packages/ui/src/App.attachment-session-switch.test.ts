import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Regression tests for C-010: cancel in-flight attachment sends after session switch.
 *
 * Verifies that sendSessionInput captures session identity at upload-start and
 * guards the socket.emit("input") with a session/generation check so that an
 * upload started in session A is never emitted to session B if the viewer
 * switched mid-flight.
 */

describe("sendSessionInput attachment cross-session switch guard", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  // Isolate the sendSessionInput function body for scoped assertions.
  // The function is declared as an async useCallback and ends at the last
  // closing bracket before the next top-level declaration.
  const fnStart = src.indexOf("const sendSessionInput = React.useCallback(async");
  const fnEnd = src.indexOf("\n  }, [", fnStart); // end of useCallback deps
  const fn = src.slice(fnStart, fnEnd);

  test("captures session identity (sessionId) before any await", () => {
    // sessionId is captured at the top of sendSessionInput, before the first await
    const captureIdx = fn.indexOf("const sessionId = lifecycleRefs.activeSessionId.current;");
    const firstAwait = fn.indexOf("await ");
    expect(captureIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(firstAwait);
  });

  test("captures generation before any await", () => {
    const captureIdx = fn.indexOf("const capturedGeneration = lifecycleRefs.generation.current;");
    const firstAwait = fn.indexOf("await ");
    expect(captureIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(firstAwait);
  });

  test("guards socket.emit with matchesViewerSession before emitting input", () => {
    // The session guard must appear before the socket.emit("input") call.
    const guardIdx = fn.indexOf('matchesViewerSession(lifecycleRefs.activeSessionId.current, sessionId)');
    const emitIdx = fn.indexOf('socket.emit("input"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(emitIdx);
  });

  test("guards socket.emit with matchesViewerGeneration before emitting input", () => {
    const guardIdx = fn.indexOf('matchesViewerGeneration(lifecycleRefs.generation.current, capturedGeneration)');
    const emitIdx = fn.indexOf('socket.emit("input"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(emitIdx);
  });

  test("guard cancels the attempt (calls failCurrentAttempt) on session mismatch path", () => {
    // The guard block must call failCurrentAttempt() and return false so the
    // upload slot is released and the dedup entry is marked failed.
    const guardBlock = fn.slice(fn.indexOf("// Guard: if the viewer switched"));
    const untilEmit = guardBlock.slice(0, guardBlock.indexOf('socket.emit("input"'));
    expect(untilEmit).toMatch(/failCurrentAttempt\(\)/);
    expect(untilEmit).toMatch(/return false/);
  });

  test("guard appears after the upload loop (same-session upload still completes)", () => {
    // The guard is placed after the attachment upload loop so that if the
    // session never changed, uploads proceed normally and only the emit is guarded.
    const uploadLoopEnd = fn.lastIndexOf("attachments = uploaded;");
    const guardIdx = fn.indexOf("// Guard: if the viewer switched");
    expect(uploadLoopEnd).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(uploadLoopEnd);
  });
});
