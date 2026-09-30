/**
 * Pure resolver for the App-level global keyboard shortcuts.
 *
 * | Shortcut                 | Action              |
 * |--------------------------|---------------------|
 * | `?` (outside inputs)     | show shortcuts help |
 * | Cmd/Ctrl + K             | focus prompt        |
 * | Ctrl + `                 | toggle terminal     |
 * | Cmd/Ctrl + Shift + E     | toggle file explorer|
 * | Cmd/Ctrl + Shift + H     | toggle history      |
 * | Cmd/Ctrl + .             | abort agent         |
 *
 * "Cmd/Ctrl" means Cmd on macOS, Ctrl elsewhere. Ctrl+` always uses Ctrl to
 * avoid the macOS Cmd+` window-switch conflict.
 */

export type GlobalShortcutAction =
  | "show-shortcuts"
  | "focus-prompt"
  | "toggle-terminal"
  | "toggle-file-explorer"
  | "toggle-history"
  | "abort";

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * @param inInput      focus is in an INPUT/TEXTAREA/contentEditable
 * @param isDialogOpen lazily checked, only for the `?` shortcut
 */
export function resolveGlobalShortcut(
  e: ShortcutKeyEvent,
  isMac: boolean,
  inInput: boolean,
  isDialogOpen: () => boolean,
): GlobalShortcutAction | null {
  const meta = isMac ? e.metaKey : e.ctrlKey;

  // ? — Show shortcuts help (only when not in an input)
  if (
    e.key === "?" &&
    !inInput &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !isDialogOpen()
  ) {
    return "show-shortcuts";
  }

  // Cmd/Ctrl + K — Focus the prompt textarea
  if (meta && !e.shiftKey && !e.altKey && e.key === "k") return "focus-prompt";

  // Ctrl + ` — Toggle terminal
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "`") return "toggle-terminal";

  // Cmd/Ctrl + Shift + E — Toggle file explorer
  if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") return "toggle-file-explorer";

  // Cmd/Ctrl + Shift + H — Toggle session history palette
  if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") return "toggle-history";

  // Cmd/Ctrl + . — Abort the active agent
  if (meta && !e.shiftKey && !e.altKey && e.key === ".") return "abort";

  return null;
}

/** True when the keyboard event target is a text-entry element. */
export function isTextEntryTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || !!target.isContentEditable;
}
