/**
 * WebPush notification subscription management for the browser.
 *
 * This module provides helpers to subscribe/unsubscribe the current browser
 * to push notifications via the Web Push API. It communicates with the
 * PizzaPi server to register the PushSubscription with VAPID credentials.
 */

let cachedVapidKey: string | null = null;

/**
 * Fetch the VAPID public key from the server (cached after first call).
 */
export async function getVapidPublicKey(): Promise<string> {
    if (cachedVapidKey) return cachedVapidKey;

    const res = await fetch("/api/push/vapid-public-key");
    if (!res.ok) throw new Error(`Failed to fetch VAPID key: ${res.status}`);
    const body = await res.json();
    cachedVapidKey = body.publicKey as string;
    return cachedVapidKey;
}

/**
 * Convert a URL-safe base64 VAPID key to a Uint8Array for the
 * PushManager.subscribe() applicationServerKey option.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * Check whether push notifications are supported in this browser.
 */
export function isPushSupported(): boolean {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Get the current Notification permission state.
 */
export function getNotificationPermission(): NotificationPermission {
    if (!("Notification" in window)) return "denied";
    return Notification.permission;
}

/**
 * Get the active PushSubscription for the current service worker, if any.
 */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
    if (!isPushSupported()) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
}

/**
 * Subscribe the current browser to push notifications.
 *
 * 1. Requests notification permission if not already granted.
 * 2. Subscribes via PushManager with the server's VAPID key.
 * 3. Sends the subscription to the server.
 *
 * Returns the PushSubscription on success, or null if permission was denied.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
    if (!isPushSupported()) {
        console.warn("[push] Push notifications are not supported in this browser.");
        return null;
    }

    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
        console.warn("[push] Notification permission denied.");
        return null;
    }

    const vapidKey = await getVapidPublicKey();
    const registration = await navigator.serviceWorker.ready;

    // Subscribe with the VAPID key
    const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
    });

    // Send subscription to server
    const keys = subscription.toJSON().keys;
    const res = await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            endpoint: subscription.endpoint,
            keys: {
                p256dh: keys?.p256dh,
                auth: keys?.auth,
            },
        }),
    });

    if (!res.ok) {
        console.error("[push] Failed to register subscription with server:", res.status);
        // Unsubscribe since server registration failed
        await subscription.unsubscribe();
        return null;
    }

    return subscription;
}

/**
 * Unsubscribe the current browser from push notifications.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
    const subscription = await getExistingSubscription();
    if (!subscription) return true;

    // Tell the server first
    try {
        await fetch("/api/push/unsubscribe", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
    } catch (err) {
        console.error("[push] Failed to unregister subscription from server:", err);
    }

    // Unsubscribe locally
    return subscription.unsubscribe();
}

/**
 * Check if the user is currently subscribed to push notifications.
 */
export async function isPushSubscribed(): Promise<boolean> {
    const sub = await getExistingSubscription();
    return sub !== null;
}
