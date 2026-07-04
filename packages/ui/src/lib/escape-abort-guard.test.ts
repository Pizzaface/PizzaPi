import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { isEscapeAbortBlocked, ESCAPE_ABORT_GUARD_ATTR } from "./escape-abort-guard";

function doc(html: string): Document {
  const win = new Window({ url: "http://localhost/" });
  // happy-dom's selector parser references window.SyntaxError, which is
  // undefined outside a registered global window (same shim as GitPanel.test).
  (win as any).SyntaxError = SyntaxError;
  win.document.body.innerHTML = html;
  return win.document as unknown as Document;
}

describe("isEscapeAbortBlocked", () => {
  test("false when nothing is open", () => {
    expect(isEscapeAbortBlocked(doc("<div>chat</div>"))).toBe(false);
  });

  test("true when a visible preview surface is mounted", () => {
    expect(isEscapeAbortBlocked(doc(`<div ${ESCAPE_ABORT_GUARD_ATTR}>preview</div>`))).toBe(true);
  });

  test("false when the preview is in a hidden CombinedPanel tab", () => {
    expect(
      isEscapeAbortBlocked(doc(`<div class="invisible"><div ${ESCAPE_ABORT_GUARD_ATTR}>preview</div></div>`)),
    ).toBe(false);
  });

  test("true when a Radix dialog is open", () => {
    expect(isEscapeAbortBlocked(doc('<div role="dialog" data-state="open">dialog</div>'))).toBe(true);
  });

  test("false when a dialog is closed", () => {
    expect(isEscapeAbortBlocked(doc('<div role="dialog" data-state="closed">dialog</div>'))).toBe(false);
  });
});
