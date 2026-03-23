/**
 * Tests for the keyboard shortcut guard logic embedded in App.tsx.
 *
 * The `?` key handler has several guards that prevent the shortcuts help
 * dialog from opening in inappropriate contexts. We extract those conditions
 * as a pure function and test each guard in isolation.
 *
 * Relevant source: packages/ui/src/App.tsx — the `handler` function inside
 * the `useEffect` that registers `keydown` on `document`.
 */

import { describe, expect, test } from "bun:test";

// ── Pure helper mirroring the guard in App.tsx ────────────────────────────────

interface ShortcutsHelpGuardParams {
  key: string;
  /** target.tagName === "INPUT" || "TEXTAREA" || isContentEditable */
  inInput: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** true when document.querySelector('[role="dialog"]') !== null */
  dialogOpen: boolean;
}

/**
 * Mirrors the condition that gates `setShowShortcutsHelp(true)` in App.tsx:
 *
 *   if (
 *     e.key === "?" &&
 *     !inInput &&
 *     !e.metaKey &&
 *     !e.ctrlKey &&
 *     !e.altKey &&
 *     !e.shiftKey &&
 *     !document.querySelector('[role="dialog"]')
 *   )
 */
function shouldTriggerShortcutsHelp(p: ShortcutsHelpGuardParams): boolean {
  return (
    p.key === "?" &&
    !p.inInput &&
    !p.metaKey &&
    !p.ctrlKey &&
    !p.altKey &&
    !p.shiftKey &&
    !p.dialogOpen
  );
}

// Convenience: baseline params that should always trigger (everything clear)
const base: ShortcutsHelpGuardParams = {
  key: "?",
  inInput: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  dialogOpen: false,
};

// ── Core dialog-guard regression ─────────────────────────────────────────────

describe("dialog guard — regression for PR #261", () => {
  test("opens shortcuts help when no dialog is open", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, dialogOpen: false })).toBe(
      true
    );
  });

  test("does NOT open shortcuts help when a dialog is open", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, dialogOpen: true })).toBe(
      false
    );
  });
});

// ── Other guards ──────────────────────────────────────────────────────────────

describe("key guard", () => {
  test("only triggers on the '?' key", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, key: "?" })).toBe(true);
    expect(shouldTriggerShortcutsHelp({ ...base, key: "/" })).toBe(false);
    expect(shouldTriggerShortcutsHelp({ ...base, key: "h" })).toBe(false);
    expect(shouldTriggerShortcutsHelp({ ...base, key: "Escape" })).toBe(false);
  });
});

describe("input guard", () => {
  test("does not trigger when focus is inside an input/textarea/contenteditable", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, inInput: true })).toBe(false);
  });

  test("triggers when focus is outside any input", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, inInput: false })).toBe(true);
  });
});

describe("modifier key guards", () => {
  test("does not trigger when metaKey is held", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, metaKey: true })).toBe(false);
  });

  test("does not trigger when ctrlKey is held", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, ctrlKey: true })).toBe(false);
  });

  test("does not trigger when altKey is held", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, altKey: true })).toBe(false);
  });

  test("does not trigger when shiftKey is held", () => {
    expect(shouldTriggerShortcutsHelp({ ...base, shiftKey: true })).toBe(false);
  });

  test("triggers when no modifier keys are held", () => {
    expect(
      shouldTriggerShortcutsHelp({
        ...base,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(true);
  });
});

// ── Combined scenarios ────────────────────────────────────────────────────────

describe("combined guard scenarios", () => {
  test("dialog open + correct key → blocked (dialog guard wins)", () => {
    expect(
      shouldTriggerShortcutsHelp({ ...base, key: "?", dialogOpen: true })
    ).toBe(false);
  });

  test("dialog open + in input → blocked (both guards active)", () => {
    expect(
      shouldTriggerShortcutsHelp({
        ...base,
        key: "?",
        inInput: true,
        dialogOpen: true,
      })
    ).toBe(false);
  });

  test("dialog closed + in input → blocked (input guard)", () => {
    expect(
      shouldTriggerShortcutsHelp({ ...base, key: "?", inInput: true })
    ).toBe(false);
  });

  test("all guards clear → triggers", () => {
    expect(shouldTriggerShortcutsHelp(base)).toBe(true);
  });
});
