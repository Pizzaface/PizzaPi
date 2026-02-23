/**
 * Haptic feedback for streaming text.
 *
 * Fires a very short vibration pulse as text deltas arrive, throttled so
 * the motor isn't hammered on every token. The effect is a gentle "purr"
 * while the agent is typing.
 *
 * Only works on devices/browsers that support the Vibration API (Android
 * Chrome, etc.). iOS Safari ignores `navigator.vibrate()` silently.
 */

const STORAGE_KEY = "pp.haptics";

let enabled: boolean | null = null;

function readPref(): boolean {
  if (enabled !== null) return enabled;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    enabled = raw === "true";
  } catch {
    enabled = false;
  }
  return enabled;
}

export function isHapticsEnabled(): boolean {
  return readPref();
}

export function setHapticsEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // storage full / blocked — ignore
  }
}

export function supportsHaptics(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

// --- Throttled stream pulse ---

/** Minimum ms between vibration pulses while streaming */
const THROTTLE_MS = 80;

/** Duration of each vibration pulse in ms */
const PULSE_MS = 8;

let lastPulseAt = 0;

/**
 * Call on every `text_delta` event. Fires a micro-vibration at most once
 * per {@link THROTTLE_MS} ms.
 */
export function pulseStreamingHaptic(): void {
  if (!readPref()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;

  const now = performance.now();
  if (now - lastPulseAt < THROTTLE_MS) return;
  lastPulseAt = now;

  navigator.vibrate(PULSE_MS);
}

/** Stop any ongoing vibration (e.g. when streaming ends). */
export function cancelHaptic(): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(0);
  }
}
