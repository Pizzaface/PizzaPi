/**
 * Synchronize CSS animations across elements using the Web Animations API.
 *
 * CSS animations start when an element mounts, so elements added at different
 * times pulse out of phase. Pure CSS cannot fix this — MDN confirms "it is
 * impossible to sync two separate animations with CSS animations."
 *
 * This module listens for `animationstart` events and forces every matching
 * animation's `startTime` to 0 on the document timeline, so they all share
 * the same phase regardless of when they mounted.
 */

/** Animation names we want to keep in lockstep. */
const SYNCED_NAMES = new Set([
  "pulse",           // Tailwind animate-pulse
  "chase-spin",      // Sidebar active row chase border
  "awaiting-pulse",  // Sidebar awaiting-input row
  "completed-pulse", // Sidebar completed-unread row
]);

let initialized = false;

/**
 * Call once at app startup. Installs a global `animationstart` listener that
 * forces all matching CSS animations to `startTime = 0`, anchoring them to
 * the document timeline origin so every instance beats in unison.
 */
export function initAnimationSync(): void {
  if (initialized) return;
  initialized = true;

  document.addEventListener(
    "animationstart",
    (e: AnimationEvent) => {
      if (!SYNCED_NAMES.has(e.animationName)) return;

      // Use rAF so we don't mutate animations mid-style-recalc
      requestAnimationFrame(() => {
        for (const anim of document.getAnimations()) {
          if (
            anim instanceof CSSAnimation &&
            SYNCED_NAMES.has(anim.animationName)
          ) {
            anim.startTime = 0;
          }
        }
      });
    },
    true, // capture phase — catches pseudo-element events that bubble
  );
}
