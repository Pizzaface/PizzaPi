/**
 * Native capability bridge for the bundled Capacitor app.
 *
 * Wires two native surfaces to the attention store:
 *  - **App icon badge** (iOS + Android): set to the count of items needing a
 *    user response (questions, plan reviews, escalations). Cleared at 0.
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
import { useNeedsResponseCount } from "../attention/index.js";

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

/** Reset internal flags — exposed for tests. */
export function _resetMobileNativeState(): void {
    permissionsRequested = false;
}

/**
 * React hook that drives the native badge from the attention store. Mount once,
 * inside <AttentionProvider>.
 */
export function useMobileNativeActivity(): void {
    const needsResponse = useNeedsResponseCount();

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

}