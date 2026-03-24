/**
 * Returns a negative `animationDelay` that anchors a CSS animation to a
 * shared global epoch so every element using the same cycle duration pulses
 * in perfect sync — regardless of when it mounts.
 *
 * Usage:
 *   <span style={syncedPulse()} className="animate-pulse" />
 *   <span style={syncedPulse(2500)} className="animate-awaiting-pulse" />
 */

/** Default Tailwind `animate-pulse` duration (ms). */
const DEFAULT_CYCLE_MS = 2000;

export function syncedPulse(
  cycleMs: number = DEFAULT_CYCLE_MS,
): React.CSSProperties {
  return { animationDelay: `${-(Date.now() % cycleMs)}ms` };
}
