/**
 * Guard for SessionViewer's Escape→abort shortcut.
 *
 * Full-panel preview surfaces (file preview, git diff view) mark their
 * container with ESCAPE_ABORT_GUARD_ATTR. While one is visible, Escape must
 * never reach the abort handler — even when keyboard focus has fallen back to
 * <body>, which defeats the focus-based interception inside those components.
 */
export const ESCAPE_ABORT_GUARD_ATTR = "data-escape-abort-guard";

/** True when Escape should NOT abort the agent turn. */
export function isEscapeAbortBlocked(doc: Document = document): boolean {
  // Radix dialogs (image lightbox, settings, …) own Escape globally.
  if (doc.querySelector('[role="dialog"][data-state="open"]')) return true;
  // A visible preview surface. Previews hidden in an inactive CombinedPanel
  // tab have an ancestor with the `invisible` class — ignore those.
  for (const el of doc.querySelectorAll(`[${ESCAPE_ABORT_GUARD_ATTR}]`)) {
    if (!el.closest(".invisible")) return true;
  }
  return false;
}
