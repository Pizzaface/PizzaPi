/**
 * Native capability bridge for the bundled Capacitor app.
 *
 * Wires two native surfaces to the attention store:
 *  - **App icon badge** (iOS + Android): set to the count of items needing a
 *    user response (questions, plan reviews, escalations). Cleared at 0.
 *  - **Android "live update" pill**: an ongoing local notification shown while
 *    one or more agent sessions are running, dismissed when they go idle. This
 *    is Android's equivalent of an iOS Live Activity — a persistent, non-
 *    dismissable notification in the shade / on the lock screen. iOS gets no
 *    equivalent here (it uses the badge only, per the agreed scope).
 *
 * Everything is a no-op outside the native Capacitor app: web builds never
 * import the native plugin code paths because the guard short-circuits before
 * any plugin call. The plugins themselves are web-safe, but we gate on
 * `isMobileBundled && Capacitor.isNativePlatform()` so the browser PWA never
 * touches them.
 */
import * as React from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Badge } from "@capawesome/capacitor-badge";
import { getMobileRuntimeConfig } from "./mobile-runtime.js";
import { startNtfyPush } from "./ntfy-push.js";
import { useNeedsResponseCount, useRunningCount } from "../attention/index.js";

/**
 * Stable notification id for the Android activity pill.
 *
 * Must NOT collide with the native ntfy service's ids in
 * android/.../NtfyForegroundService.java: SUMMARY=0x8_FFFF, SERVICE=0x9_0000,
 * FIRST_MESSAGE=0x9_0001 and counting up for each message. We sit well above
 * that range so message notifications never overwrite the pill (and vice versa).
 * Keep these two files in sync if either range grows.
 */
const ACTIVITY_NOTIF_ID = 0xa_0000;

/** Dedicated low-importance channel id for the Android activity pill. */
const ACTIVITY_CHANNEL_ID = "pizzapi-agent-activity";

let activityChannelEnsured = false;

/**
 * Create the low-importance notification channel used by the Android
 * activity pill. Idempotent — safe to call on every state transition.
 */
async function ensureActivityChannel(): Promise<void> {
    if (activityChannelEnsured) return;
    activityChannelEnsured = true;
    if (!nativeEnabled() || Capacitor.getPlatform() !== "android") return;
    try {
        await LocalNotifications.createChannel({
            id: ACTIVITY_CHANNEL_ID,
            name: "Agent activity",
            description: "Persistent status while an agent session is running",
            // IMPORTANCE_MIN: shown in the notification shade, no status bar icon,
            // no sound, no vibration.
            importance: 1,
            vibration: false,
            lights: false,
        });
    } catch (err) {
        console.error("mobile-native: failed to create activity channel:", err);
    }
}

/** True only when running inside the bundled Capacitor native shell. */
function nativeEnabled(): boolean {
    return getMobileRuntimeConfig().isMobileBundled && Capacitor.isNativePlatform();
}

/**
 * Request notification + badge authorization. Called once on first mount of
 * the bridge. Safe to call repeatedly — it self-guards via a module flag and
 * the OS only prompts once.
 */
let permissionsRequested = false;
export async function requestNativePermissions(): Promise<void> {
    if (!nativeEnabled() || permissionsRequested) return;
    permissionsRequested = true;
    try {
        // Local notifications cover the Android pill; badge authorization is
        // requested separately (iOS bundles it with notifications, but the
        // badge plugin asks explicitly so Android badge also works).
        await LocalNotifications.requestPermissions();
        await Badge.requestPermissions();
    } catch (err) {
        console.error("mobile-native: failed to request permissions:", err);
    }
}

/**
 * Set the app icon badge to `count` (0 clears it). No-op on web.
 *
 * Note: on iOS, `Badge.set({ count: 0 })` / `Badge.clear()` also dismisses
 * delivered notifications — acceptable here since iOS only uses the badge.
 */
export async function setActivityBadge(count: number): Promise<void> {
    if (!nativeEnabled()) return;
    const n = Math.max(0, Math.floor(count));
    try {
        if (n > 0) {
            await Badge.set({ count: n });
        } else {
            await Badge.clear();
        }
    } catch (err) {
        console.error("mobile-native: failed to set badge:", err);
    }
}

// Tracks whether the Android ongoing notification is currently posted, so we
// only schedule/cancel on state transitions (avoids re-posting every tick).
let androidPillShown = false;

/**
 * Show or hide the Android ongoing "agent working" notification. No-op on iOS
 * and web. Only acts on 0→N and N→0 transitions.
 *
 * @param runningCount number of currently-running agent sessions
 * @param summary optional human-readable body; defaults to a count-based string
 */
export async function setAndroidActivityPill(
    runningCount: number,
    summary?: string,
): Promise<void> {
    if (!nativeEnabled() || Capacitor.getPlatform() !== "android") return;
    try {
        if (runningCount > 0 && !androidPillShown) {
            await ensureActivityChannel();
            const body =
                summary ??
                (runningCount === 1
                    ? "Agent session running"
                    : `${runningCount} agent sessions running`);
            await LocalNotifications.schedule({
                notifications: [
                    {
                        id: ACTIVITY_NOTIF_ID,
                        title: "PizzaPi",
                        body,
                        channelId: ACTIVITY_CHANNEL_ID,
                        // Ongoing => can't be swiped away; renders as a live
                        // update pill on Android 16+ and a persistent shade
                        // entry on older versions.
                        ongoing: true,
                        // Don't ring/vibrate on every state change — this is a
                        // status indicator, not an alert.
                        silent: true,
                    },
                ],
            });
            androidPillShown = true;
        } else if (runningCount === 0 && androidPillShown) {
            await LocalNotifications.cancel({
                notifications: [{ id: ACTIVITY_NOTIF_ID }],
            });
            androidPillShown = false;
        }
    } catch (err) {
        console.error("mobile-native: failed to update activity pill:", err);
    }
}

/** Reset internal flags — exposed for tests. */
export function _resetMobileNativeState(): void {
    permissionsRequested = false;
    androidPillShown = false;
    activityChannelEnsured = false;
}

/**
 * React hook that drives the native badge + Android activity pill from the
 * attention store. Mount once, inside <AttentionProvider>.
 *
 * - Requests notification/badge permission on first mount (native only).
 * - Mirrors `needsResponseCount` to the app icon badge.
 * - Mirrors `runningCount > 0` to the Android ongoing notification pill.
 */
export function useMobileNativeActivity(): void {
    const needsResponse = useNeedsResponseCount();
    const running = useRunningCount();

    // Request permissions once on mount.
    React.useEffect(() => {
        void requestNativePermissions();
        // Start the ntfy foreground-service push stream on Android. No-op on
        // web/iOS. Best-effort — the server returns 503 if ntfy isn't configured,
        // in which case startNtfyPush degrades silently (Web Push still runs).
        void startNtfyPush();
    }, []);

    // Badge reflects "needs your response" — the conventional unread signal.
    React.useEffect(() => {
        void setActivityBadge(needsResponse);
    }, [needsResponse]);

    // Android pill reflects "agent is actively working".
    React.useEffect(() => {
        void setAndroidActivityPill(running);
    }, [running]);
}