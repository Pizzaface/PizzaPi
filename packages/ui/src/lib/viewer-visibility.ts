/**
 * Payload for the `viewer_visibility` client→server event, which tells the
 * server whether the tab is actually being looked at (so it can suppress
 * native push while a viewer is visible).
 *
 * "Visible" is `document.visibilityState === "visible"` — window focus is
 * intentionally ignored, since a session on a second monitor still counts
 * as being viewed.
 */
export function getViewerVisibilityPayload(): { visible: boolean } {
  return { visible: document.visibilityState === "visible" };
}
