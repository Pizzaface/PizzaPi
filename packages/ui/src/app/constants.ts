/**
 * Build metadata and viewer-connection timing constants shared by the App
 * shell and its extracted hooks.
 */

declare const __PIZZAPI_UI_VERSION__: string;
export const UI_VERSION = typeof __PIZZAPI_UI_VERSION__ === "string" && __PIZZAPI_UI_VERSION__.trim()
  ? __PIZZAPI_UI_VERSION__.trim()
  : "0.0.0";

declare const __PIZZAPI_BUILD_TIMESTAMP__: string;
export const BUILD_TIMESTAMP =
  typeof __PIZZAPI_BUILD_TIMESTAMP__ === "string" && __PIZZAPI_BUILD_TIMESTAMP__.trim()
    ? __PIZZAPI_BUILD_TIMESTAMP__.trim()
    : null;

// When we last asked the server to hydrate, a request that stalls longer than
// this is retried. A hydration request has no ack, so this is the only way to
// notice one that was answered with nothing.
export const HYDRATION_STALL_MS = 8_000;
// First retry fires sooner: a dropped first snapshot otherwise always costs
// the full stall window. Later retries keep the longer threshold so a slow
// link streaming a big snapshot isn't hammered with duplicate requests.
export const HYDRATION_FIRST_RETRY_MS = 3_500;
export const HYDRATION_CHECK_INTERVAL_MS = 2_000;
// ponytail: two retries, then surface the failure. Retrying forever would
// re-request a full snapshot every 8s against a session that cannot answer.
export const HYDRATION_MAX_RETRIES = 2;
/** Heartbeats currently arrive every 10s. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_CHECK_INTERVAL_MS = 15_000;
/** How long to ignore runner queue syncs after a local queue mutation. */
export const QUEUE_SYNC_SUPPRESS_MS = 5_000;

/**
 * Stale-connection threshold. Hidden tabs get a longer grace period because
 * browser timer throttling can delay both heartbeat delivery and checks.
 */
export function getStaleThresholdMs(isPageHidden: boolean): number {
  return (isPageHidden ? 18 : 3) * HEARTBEAT_INTERVAL_MS;
}

/** Random id used for exec requests: `${Date.now()}-${random hex}`. */
export function makeExecId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
