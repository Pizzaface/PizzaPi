// ============================================================================
// App.test.tsx — Switch-race resync hydration guard tests (A2-016)
//
// Verifies that replay envelopes stamped with a session ID are dropped by the
// client when the active viewer session has switched, preventing cross-session
// state corruption.
// ============================================================================

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { matchesViewerSession } from "@/lib/viewer-switch";

// ── matchesViewerSession — client-side replay filter ─────────────────────────

describe("matchesViewerSession — resync switch-race guard", () => {
  test("drops replay stamped with wrong session (cross-session bleed)", () => {
    // Viewer switched from A to B. A replay envelope arrives stamped for A.
    expect(matchesViewerSession("session-B", "session-A")).toBe(false);
  });

  test("accepts replay stamped with the current session", () => {
    expect(matchesViewerSession("session-A", "session-A")).toBe(true);
  });

  test("accepts unstamped replay envelope (older server, no sessionId)", () => {
    // Older servers don't stamp envelopes — accept and let generation guard apply.
    expect(matchesViewerSession("session-B", undefined)).toBe(true);
  });

  test("accepts replay when active session is null but envelope is also null/undefined", () => {
    expect(matchesViewerSession(null, undefined)).toBe(true);
  });

  test("drops when active session is null but envelope has a specific sessionId", () => {
    // No active session yet; a stale replay for an old session must be dropped.
    expect(matchesViewerSession(null, "session-A")).toBe(false);
  });
});

// ── App.tsx structural wiring ─────────────────────────────────────────────────

describe("App.tsx wiring — matchesViewerSession applied to resync replay path", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("imports matchesViewerSession from viewer-switch", () => {
    expect(src).toMatch(/matchesViewerSession/);
  });

  test("reads sessionId from the viewer event envelope", () => {
    // The envelope destructuring must extract sessionId.
    expect(src).toMatch(/sessionId.*envelopeSessionId|envelopeSessionId.*sessionId/);
  });

  test("calls matchesViewerSession before processing envelope events", () => {
    // Guard is called in the hot path before any state mutations.
    expect(src).toMatch(/matchesViewerSession\(.*activeSessionId.*envelopeSessionId/s);
  });
});
