/**
 * ntfy push — Android background push via a self-hosted ntfy instance, without
 * Google/FCM. The PizzaPi app's foreground service (NtfyForegroundService)
 * holds a persistent subscribe stream to the user's per-device ntfy topic and
 * posts notifications as the PizzaPi app.
 *
 * This module is the JS bridge to the local Capacitor plugin `PizzapiNtfy`
 * (registered in MainActivity). On web/PWA it is a no-op — the Web Push (VAPID)
 * path in `push.ts` handles browser notifications there.
 *
 * Prototype (Phase 2): start/stop only. No JS event callbacks yet.
 * Requires an Android device/emulator to verify background behavior — see
 * deployment/mobile-push.mdx for limitations.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { getMobileRuntimeConfig, resolveMobileUrl } from "./mobile-runtime.js";

export interface NtfyStartOptions {
    /** Public ntfy base URL the device subscribes to (PIZZAPI_NTFY_PUBLIC_URL). */
    ntfyUrl: string;
    /** Per-device unguessable topic returned by /api/push/register-native. */
    topic: string;
    /** Optional bearer token for per-device ntfy auth (Phase 3). */
    token?: string;
}

export interface PizzapiNtfyPlugin {
    start(options: NtfyStartOptions): Promise<void>;
    stop(): Promise<void>;
    addListener(
        eventName: "notificationTapped" | "connectionState",
        listener: (event: Record<string, unknown>) => void,
    ): Promise<PluginListenerHandle>;
}

// Web no-op implementation so registerPlugin never rejects on the PWA build.
class PizzapiNtfyWeb implements PizzapiNtfyPlugin {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async addListener(): Promise<PluginListenerHandle> {
        return { remove: async () => {} } as PluginListenerHandle;
    }
}

const PizzapiNtfy = registerPlugin<PizzapiNtfyPlugin>("PizzapiNtfy", {
    web: async () => new PizzapiNtfyWeb(),
});

/** True when this is the Android native app (the only platform with the service). */
function androidNative(): boolean {
    const { isMobileBundled } = getMobileRuntimeConfig();
    return isMobileBundled && Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/** True when native (ntfy) push is available on this platform. */
export function isNativePushAvailable(): boolean {
    return androidNative();
}

// ponytail: two localStorage flags are the entire preference store — one for
// disabled state, one for child-suppression. Both are synced to the server on
// write; on read they serve as a cache so no round-trip is needed in the
// render path.
const NTFY_DISABLED_KEY = "pizzapi.ntfyPushDisabled";
const NTFY_SUPPRESS_CHILD_KEY = "pizzapi.ntfySuppressChild";

/** User preference: native push explicitly disabled from the UI. */
export function isNativePushDisabled(): boolean {
    try {
        return localStorage.getItem(NTFY_DISABLED_KEY) === "1";
    } catch {
        return false;
    }
}

export function setNativePushDisabled(disabled: boolean): void {
    try {
        if (disabled) localStorage.setItem(NTFY_DISABLED_KEY, "1");
        else localStorage.removeItem(NTFY_DISABLED_KEY);
    } catch {
        // ignore
    }
}

/**
 * Read the cached native child-suppression preference (from localStorage).
 * Written by `setNativeSuppressChildNotifications` and by `startNtfyPush`
 * when the server returns the current value.
 */
export function getNativeSuppressChildNotifications(): boolean {
    try {
        return localStorage.getItem(NTFY_SUPPRESS_CHILD_KEY) === "1";
    } catch {
        return false;
    }
}

/**
 * Persist the native child-suppression preference to the server and update
 * the local cache. Returns true on success, false on network/server error.
 */
export async function setNativeSuppressChildNotifications(suppress: boolean): Promise<boolean> {
    try {
        const res = await fetch(resolveMobileUrl("/api/push/child-notifications-native"), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ suppress }),
        });
        if (!res.ok) return false;
        // Update local cache after confirmed server write.
        try {
            if (suppress) localStorage.setItem(NTFY_SUPPRESS_CHILD_KEY, "1");
            else localStorage.removeItem(NTFY_SUPPRESS_CHILD_KEY);
        } catch { /* ignore */ }
        return true;
    } catch {
        return false;
    }
}

/** Whether the OS notification permission is currently granted. */
export async function hasNativePushPermission(): Promise<boolean> {
    if (!androidNative()) return false;
    try {
        const { display } = await LocalNotifications.checkPermissions();
        return display === "granted";
    } catch {
        return false;
    }
}

/** Prompt for the OS notification permission. Returns true if granted. */
export async function requestNativePushPermission(): Promise<boolean> {
    if (!androidNative()) return false;
    try {
        const { display } = await LocalNotifications.requestPermissions();
        return display === "granted";
    } catch {
        return false;
    }
}

/**
 * Outcome of a registration attempt. `unconfigured` is the 503 the server
 * returns when it has no ntfy instance set up — a distinct, user-visible
 * state, not a generic failure. `error` covers everything else (network,
 * malformed response, plugin start failure).
 */
export type NtfyStartResult = { ok: true } | { ok: false; reason: "unconfigured" | "error" };

/**
 * Register with the server for native push and start the foreground-service
 * subscribe stream. No-op outside the Android native app. Safe to call on
 * every launch — registration is idempotent (server reuses the topic per
 * user+platform), and starting an already-running service re-configures it.
 *
 * Requires `PIZZAPI_NTFY_URL` to be configured on the server; returns
 * `{ ok: false, reason: "unconfigured" }` if the server reports ntfy is not
 * configured, so callers can degrade gracefully instead of claiming success.
 */
export async function startNtfyPush(): Promise<NtfyStartResult> {
    // ponytail: "nothing to do" reports ok — callers must check platform/disabled
    // state THEMSELVES before treating ok as "registered". Both current callers do.
    if (!androidNative() || isNativePushDisabled()) return { ok: true };
    try {
        const res = await fetch(resolveMobileUrl("/api/push/register-native"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ platform: "android" }),
        });
        if (!res.ok) {
            // 503 = ntfy not configured on the server → distinct state, not an error.
            if (res.status === 503) {
                return { ok: false, reason: "unconfigured" };
            }
            console.error("ntfy register-native failed:", res.status);
            return { ok: false, reason: "error" };
        }
        const body = (await res.json()) as {
            ntfyPublicUrl?: string;
            topic?: string;
            ntfyUser?: string | null;
            ntfyPass?: string | null;
            suppressChildNotifications?: boolean;
        };
        // Cache the server preference. Older servers omit this field, so retain
        // the historical safe default of suppressing child-session pushes.
        try {
            if (body.suppressChildNotifications !== false) localStorage.setItem(NTFY_SUPPRESS_CHILD_KEY, "1");
            else localStorage.removeItem(NTFY_SUPPRESS_CHILD_KEY);
        } catch { /* ignore */ }
        if (!body.ntfyPublicUrl || !body.topic) {
            console.error("ntfy register-native returned no topic/url");
            return { ok: false, reason: "error" };
        }
        // Phase 1: subscribe anonymously. ntfy is provisioned with anonymous
        // read-only on `pizzapi-*` (see deployment/mobile-push.mdx), and the
        // topic is the secret. No token until Phase 3 adds per-device users.
        await PizzapiNtfy.start({
            ntfyUrl: body.ntfyPublicUrl,
            topic: body.topic,
            token: undefined,
        });
        return { ok: true };
    } catch (err) {
        console.error("startNtfyPush failed:", err);
        return { ok: false, reason: "error" };
    }
}

/** Stop the foreground service and unregister from the server. */
export async function stopNtfyPush(): Promise<void> {
    if (!androidNative()) return;
    try {
        await PizzapiNtfy.stop();
    } catch (err) {
        console.error("stopNtfyPush (plugin) failed:", err);
    }
    try {
        await fetch(resolveMobileUrl("/api/push/unregister-native"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ platform: "android" }),
        });
    } catch (err) {
        // Unregister is best-effort — don't surface.
        console.error("stopNtfyPush (unregister) failed:", err);
    }
}

// ponytail: module-level guard so re-registering (e.g. HMR, repeated hook
// mounts) doesn't stack duplicate listeners.
let tapListenerRegistered = false;

/**
 * Register the `notificationTapped` listener so tapping a PizzaPi Android
 * notification navigates to the session in-app instead of opening a browser.
 * Dispatches the existing `pp-navigate-session` CustomEvent that App.tsx
 * already listens for. No-op outside the Android native app.
 *
 * Safe to call once at app start (see mobile-native.ts). The native side
 * (NtfyPushPlugin) retains a cold-start tap event until this listener
 * attaches, so calling this on startup — even if the intent that launched
 * the app already carried a tap before JS was ready — still delivers it.
 */
export function registerNtfyTapListener(): void {
    if (!androidNative() || tapListenerRegistered) return;
    tapListenerRegistered = true;
    void PizzapiNtfy.addListener("notificationTapped", handleNotificationTapped);
}

/**
 * Handles a raw `notificationTapped` plugin event by dispatching the
 * `pp-navigate-session` CustomEvent App.tsx listens for. Exported
 * (unguarded by the androidNative() check) so it's directly unit-testable.
 */
export function handleNotificationTapped(event: Record<string, unknown>): void {
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : undefined;
    if (!sessionId) return;
    window.dispatchEvent(new CustomEvent("pp-navigate-session", { detail: { sessionId } }));
}

/** Reset internal flags — exposed for tests. */
export function _resetNtfyPushState(): void {
    tapListenerRegistered = false;
}