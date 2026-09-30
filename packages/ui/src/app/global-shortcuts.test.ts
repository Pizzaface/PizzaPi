import { describe, expect, test } from "bun:test";
import { isTextEntryTarget, resolveGlobalShortcut, type ShortcutKeyEvent } from "./global-shortcuts";

const key = (k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const noDialog = () => false;

describe("resolveGlobalShortcut", () => {
  test("? opens shortcuts help outside inputs and dialogs", () => {
    expect(resolveGlobalShortcut(key("?", { shiftKey: true }), true, false, noDialog)).toBe("show-shortcuts");
    expect(resolveGlobalShortcut(key("?"), true, true, noDialog)).toBeNull();
    expect(resolveGlobalShortcut(key("?"), true, false, () => true)).toBeNull();
    expect(resolveGlobalShortcut(key("?", { ctrlKey: true }), false, false, noDialog)).toBeNull();
  });

  test("dialog check is lazy (only evaluated for ?)", () => {
    let checked = 0;
    resolveGlobalShortcut(key("k", { metaKey: true }), true, false, () => { checked++; return false; });
    expect(checked).toBe(0);
  });

  test("Cmd/Ctrl+K focuses the prompt depending on platform", () => {
    expect(resolveGlobalShortcut(key("k", { metaKey: true }), true, true, noDialog)).toBe("focus-prompt");
    expect(resolveGlobalShortcut(key("k", { ctrlKey: true }), true, false, noDialog)).toBeNull();
    expect(resolveGlobalShortcut(key("k", { ctrlKey: true }), false, false, noDialog)).toBe("focus-prompt");
  });

  test("Ctrl+` toggles the terminal on every platform", () => {
    expect(resolveGlobalShortcut(key("`", { ctrlKey: true }), true, false, noDialog)).toBe("toggle-terminal");
    expect(resolveGlobalShortcut(key("`", { metaKey: true }), true, false, noDialog)).toBeNull();
  });

  test("Cmd/Ctrl+Shift+E / H toggle files and history (case-insensitive)", () => {
    expect(resolveGlobalShortcut(key("E", { metaKey: true, shiftKey: true }), true, false, noDialog)).toBe("toggle-file-explorer");
    expect(resolveGlobalShortcut(key("h", { ctrlKey: true, shiftKey: true }), false, false, noDialog)).toBe("toggle-history");
    expect(resolveGlobalShortcut(key("e", { metaKey: true }), true, false, noDialog)).toBeNull();
  });

  test("Cmd/Ctrl+. aborts", () => {
    expect(resolveGlobalShortcut(key(".", { metaKey: true }), true, false, noDialog)).toBe("abort");
    expect(resolveGlobalShortcut(key(".", { metaKey: true, altKey: true }), true, false, noDialog)).toBeNull();
  });

  test("plain keys do nothing", () => {
    expect(resolveGlobalShortcut(key("a"), true, false, noDialog)).toBeNull();
  });
});

describe("isTextEntryTarget", () => {
  test("detects inputs, textareas and contentEditable", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
