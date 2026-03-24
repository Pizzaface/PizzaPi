/**
 * Returns style props that anchor a CSS animation to a shared global epoch
 * so every element using the same cycle duration pulses in perfect sync —
 * regardless of when it mounts.
 *
 * Sets both `animationDelay` (for animations on the element itself, e.g.
 * Tailwind `animate-pulse`) and `--sync-delay` (a CSS custom property that
 * pseudo-element animations like `::before` can reference).
 *
 * Usage:
 *   <span style={syncedPulse()} className="animate-pulse" />
 *   <div  style={syncedPulse(2000)} className="animate-working-chase" />
 */

/** Default Tailwind `animate-pulse` / chase-spin duration (ms). */
const DEFAULT_CYCLE_MS = 2000;

export function syncedPulse(
  cycleMs: number = DEFAULT_CYCLE_MS,
): React.CSSProperties {
  const delay = `${-(Date.now() % cycleMs)}ms`;
  return {
    animationDelay: delay,
    // Custom property for pseudo-element animations (::before, ::after)
    "--sync-delay": delay,
  } as React.CSSProperties;
}
