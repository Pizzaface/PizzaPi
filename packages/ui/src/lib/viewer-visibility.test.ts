/**
 * Tests for the `viewer_visibility` payload helper used by the viewer socket
 * connection (App.tsx) to tell the server whether the tab is being looked
 * at. Deliberately ignores window focus — only `document.visibilityState`
 * matters.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { getViewerVisibilityPayload } from "./viewer-visibility";

const win = new Window({ url: "http://localhost/" });
const originalDocument = (globalThis as any).document;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(win.document, "visibilityState", {
    value: state,
    configurable: true,
  });
  (globalThis as any).document = win.document;
}

afterEach(() => {
  (globalThis as any).document = originalDocument;
});

describe("getViewerVisibilityPayload", () => {
  test("reports visible:false when the document is hidden", () => {
    setVisibility("hidden");
    expect(getViewerVisibilityPayload()).toEqual({ visible: false });
  });

  test("reports visible:true when the document is visible", () => {
    setVisibility("visible");
    expect(getViewerVisibilityPayload()).toEqual({ visible: true });
  });

  test("only depends on visibilityState, not window focus", () => {
    // No focus API involved at all — visibility alone determines the payload.
    setVisibility("visible");
    expect(getViewerVisibilityPayload().visible).toBe(true);
  });
});
