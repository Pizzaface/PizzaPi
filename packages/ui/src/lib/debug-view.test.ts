import { describe, expect, test } from "bun:test";
import { shouldShowViewerEventsDebugPage } from "./debug-view";

describe("shouldShowViewerEventsDebugPage", () => {
  test("returns true for the debug route when debug view is enabled", () => {
    expect(shouldShowViewerEventsDebugPage("/debug/viewer-events", true)).toBe(true);
    expect(shouldShowViewerEventsDebugPage("/debug/viewer-events/", true)).toBe(true);
    expect(shouldShowViewerEventsDebugPage("/session/abc", true)).toBe(false);
    expect(shouldShowViewerEventsDebugPage("/debug/viewer-events", false)).toBe(false);
  });
});
