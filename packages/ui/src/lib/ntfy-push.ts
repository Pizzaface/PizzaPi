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

// ponytail: one localStorage flag is the entire "disabled" preference store.
const NTFY_DISABLED_KEY = "pizzapi.ntfyPushDisabled";

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
 * Register with the server for native push and start the foreground-service
 * subscribe stream. No-op outside the Android native app. Safe to call on
 * every launch — registration is idempotent (server reuses the topic per
 * user+platform), and starting an already-running service re-configures it.
 *
 * Requires `PIZZAPI_NTFY_URL` to be configured on the server (returns silently
 * if the server reports ntfy is not configured, so the app degrades gracefully).
 */
export async function startNtfyPush(): Promise<void> {
    if (!androidNative() || isNativePushDisabled()) return;
    try {
        const res = await fetch(resolveMobileUrl("/api/push/register-native"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ platform: "android" }),
        });
        if (!res.ok) {
            // 503 = ntfy not configured on the server → degrade silently.
            if (res.status !== 503) {
                console.error("ntfy register-native failed:", res.status);
            }
            return;
        }
        const body = (await res.json()) as {
            ntfyPublicUrl?: string;
            topic?: string;
            ntfyUser?: string | null;
            ntfyPass?: string | null;
        };
        if (!body.ntfyPublicUrl || !body.topic) {
            console.error("ntfy register-native returned no topic/url");
            return;
        }
        // Phase 1: no per-device auth (topic is the secret). ntfyUser/Pass are
        // null until Phase 3 provisions per-device ntfy users.
        await PizzapiNtfy.start({
            ntfyUrl: body.ntfyPublicUrl,
            topic: body.topic,
            token: body.ntfyUser ? undefined : undefined, // reserved for Phase 3
        });
    } catch (err) {
        console.error("startNtfyPush failed:", err);
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