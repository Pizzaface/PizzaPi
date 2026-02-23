/**
 * Haptic feedback for streaming text.
 *
 * Fires a vibration pulse whose duration scales with the length of each
 * text chunk — short words get a light tap, longer chunks get a meatier
 * buzz. Throttled so the motor isn't hammered on every token.
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
const THROTTLE_MS = 30;

/** Vibration duration range in ms */
const MIN_PULSE_MS = 2;
const MAX_PULSE_MS = 12;

/** Text length range that maps to pulse duration */
const SHORT_TEXT = 1;
const LONG_TEXT = 30;

let lastPulseAt = 0;

/**
 * Map a text delta length to a vibration duration.
 *
 *  - 1 char  →  2ms  (tiny tap)
 *  - 5 chars →  ~4ms (light tap)
 *  - 15 chars → ~8ms (medium buzz)
 *  - 30+ chars → 12ms (full pulse)
 */
function pulseDuration(textLength: number): number {
  const clamped = Math.max(SHORT_TEXT, Math.min(textLength, LONG_TEXT));
  const t = (clamped - SHORT_TEXT) / (LONG_TEXT - SHORT_TEXT);
  return Math.round(MIN_PULSE_MS + t * (MAX_PULSE_MS - MIN_PULSE_MS));
}

/**
 * Call on every `text_delta` event with the delta text. Fires a
 * micro-vibration scaled to the chunk length, throttled to at most once
 * per {@link THROTTLE_MS} ms.
 */
export function pulseStreamingHaptic(delta?: string): void {
  if (!readPref()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;

  const now = performance.now();
  if (now - lastPulseAt < THROTTLE_MS) return;
  lastPulseAt = now;

  const len = delta ? delta.length : 1;
  navigator.vibrate(pulseDuration(len));
}

// --- Tool "typing" haptic (repeating double-tap) ---

/**
 * Messenger-style "someone is typing" pattern:
 * tap, pause, tap, long pause … repeat
 *
 * The vibrate() array alternates [vibrate, pause, vibrate, pause, …].
 * We pack one full cycle into a single call and re-fire it on an
 * interval so it loops seamlessly for the entire tool duration.
 */
const TOOL_TAP_MS = 8;
const TOOL_GAP_MS = 70;       // pause between the two taps
const TOOL_CYCLE_MS = 1200;   // time between each double-tap cycle
// Total pattern duration: tap + gap + tap = 86ms, then silence until next cycle
const TOOL_PATTERN = [TOOL_TAP_MS, TOOL_GAP_MS, TOOL_TAP_MS];

let toolTimer: ReturnType<typeof setInterval> | null = null;

/** Start a repeating double-tap while a tool is active. */
export function startToolHaptic(): void {
  if (!readPref()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (toolTimer !== null) return; // already running

  navigator.vibrate(TOOL_PATTERN);

  toolTimer = setInterval(() => {
    if (!readPref()) {
      stopToolHaptic();
      return;
    }
    navigator.vibrate(TOOL_PATTERN);
  }, TOOL_CYCLE_MS);
}

/** Stop the tool haptic immediately. */
export function stopToolHaptic(): void {
  if (toolTimer !== null) {
    clearInterval(toolTimer);
    toolTimer = null;
  }
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(0);
  }
}

/** Stop any ongoing vibration (e.g. when streaming ends). */
export function cancelHaptic(): void {
  stopToolHaptic();
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(0);
  }
}
