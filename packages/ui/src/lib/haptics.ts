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
const THROTTLE_MS = 60;

/** Vibration duration range in ms */
const MIN_PULSE_MS = 4;
const MAX_PULSE_MS = 25;

/** Text length range that maps to pulse duration */
const SHORT_TEXT = 1;
const LONG_TEXT = 30;

let lastPulseAt = 0;

/**
 * Map a text delta length to a vibration duration.
 *
 *  - 1 char  →  4ms  (tiny tap)
 *  - 5 chars →  ~8ms (light tap)
 *  - 15 chars → ~15ms (medium buzz)
 *  - 30+ chars → 25ms (full pulse)
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

// --- Tool execution heartbeat (o~ o~) ---

/** Interval between double-tap pulses while a tool is running */
const TOOL_HEARTBEAT_MS = 2000;

/**
 * Double-tap pattern: buzz, pause, buzz
 * Feels like a gentle "o~ o~" nudge.
 */
const TOOL_PATTERN = [10, 80, 10];

let toolHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Start a repeating double-tap while a tool is active. */
export function startToolHaptic(): void {
  if (!readPref()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (toolHeartbeatTimer !== null) return; // already running

  // Immediate first pulse
  navigator.vibrate(TOOL_PATTERN);

  toolHeartbeatTimer = setInterval(() => {
    if (!readPref()) {
      stopToolHaptic();
      return;
    }
    navigator.vibrate(TOOL_PATTERN);
  }, TOOL_HEARTBEAT_MS);
}

/** Stop the tool heartbeat vibration. */
export function stopToolHaptic(): void {
  if (toolHeartbeatTimer !== null) {
    clearInterval(toolHeartbeatTimer);
    toolHeartbeatTimer = null;
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
