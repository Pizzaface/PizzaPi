/**
 * Mobile bundled runtime detection + secure API-key storage.
 *
 * The Capacitor bootstrap page (mobile/index.html) stores the relay server URL
 * in localStorage (not sensitive) and hands a freshly redeemed API key to the
 * bundled UI through a URL fragment (#pizzapi.apiKey=…). The UI stores that key
 * in native secure storage (iOS Keychain / Android Keystore-encrypted
 * SharedPreferences) and never in clear-text localStorage.
 *
 * `getMobileRuntimeConfig()` stays synchronous: it returns an in-memory cache
 * of the API key that is populated asynchronously by `initMobileRuntime()`
 * (called once before first render in main.ts). On web/PWA the secure-storage
 * path is a no-op and `apiKey` is always null.
 */

import { Capacitor } from "@capacitor/core";

const SERVER_URL_KEY = "pizzapi.serverUrl";
const API_KEY_LEGACY_KEY = "pizzapi.apiKey";
const API_KEY_STORAGE_PREFIX = "pizzapi.apiKey.";
const HASH_API_KEY_PARAM = "pizzapi.apiKey";

export interface MobileRuntimeConfig {
    /** True when the app is running from the bundled Capacitor app assets. */
    isMobileBundled: boolean;
    /** Relay server base URL, e.g. https://relay.example.com */
    serverUrl: string | null;
    /** API key minted during mobile-link approval (cached from secure storage). */
    apiKey: string | null;
}

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function removeStorage(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch {
        // ignore
    }
}

/** True only when running inside the bundled Capacitor native shell. */
function nativeEnabled(): boolean {
    // isMobileBundled is derived from the stored server URL (only the
    // bootstrap page sets it), and we additionally require a native platform
    // so the web/PWA build never touches secure storage.
    return !!readStorage(SERVER_URL_KEY) && Capacitor.isNativePlatform();
}

/** Build the per-server secure-storage key for an API key. */
function apiKeyStorageKey(serverUrl: string): string {
    return API_KEY_STORAGE_PREFIX + serverUrl;
}

/** Cached API key for the current server, populated by init/load. */
let apiKeyCache: string | null = null;

/** Read the cached runtime config. Synchronous; apiKey may be null until loaded. */
export function getMobileRuntimeConfig(): MobileRuntimeConfig {
    const serverUrl = readStorage(SERVER_URL_KEY);
    return {
        isMobileBundled: !!serverUrl,
        serverUrl,
        apiKey: apiKeyCache,
    };
}

/** Resolve a relative API path against the configured mobile server URL. */
export function resolveMobileUrl(path: string): string {
    if (!path.startsWith("/")) return path;
    const { serverUrl } = getMobileRuntimeConfig();
    if (!serverUrl) return path;
    const base = serverUrl.replace(/\/+$/, "");
    return `${base}${path}`;
}

/**
 * Dynamically import the native secure-storage plugin. No-op on web.
 *
 * IMPORTANT: the returned Capacitor plugin proxy (registerPlugin()'s Proxy)
 * answers ANY property access — including `.then` — with a callable native-
 * method-wrapper (a long-standing Capacitor core bug, still open as of
 * @capacitor/core 8.4.1: https://github.com/ionic-team/capacitor/issues/8472).
 * If an `async function` directly `return`s the bare proxy, the JS engine's
 * implicit `PromiseResolve` sees a callable `.then` and treats it as a
 * Thenable, dispatching a native bridge call for the (nonexistent) method
 * "then" — which the platform rejects with "SecureStorage.then() is not
 * implemented on android" and the outer await never settles → boot() hangs
 * forever before React ever renders (silent black screen, no error, no logs).
 * Wrapping the proxy in a plain `{ plugin }` container defeats the Thenable
 * duck-typing check (plain objects have no `.then`), per the upstream-
 * documented workaround.
 */
async function getSecureStorage(): Promise<{ plugin: any } | null> {
    if (!nativeEnabled()) return null;
    try {
        const mod = await import("@aparajita/capacitor-secure-storage");
        return { plugin: (mod as any).SecureStorage };
    } catch (err) {
        console.error("mobile-runtime: secure storage unavailable:", err);
        return null;
    }
}

/**
 * Load the API key for the configured server from native secure storage into
 * the in-memory cache. Includes a one-time migration from the legacy
 * clear-text localStorage key, then removes it. No-op on web.
 */
export async function loadMobileApiKey(): Promise<void> {
    const { serverUrl } = getMobileRuntimeConfig();
    if (!serverUrl) {
        apiKeyCache = null;
        return;
    }

    const storage = await getSecureStorage();
    if (!storage) return;
    const SecureStorage = storage.plugin;

    const key = apiKeyStorageKey(serverUrl);
    try {
        let value = (await SecureStorage.get(key)) as string | null;
        if (value == null) {
            // One-time migration from legacy clear-text localStorage key.
            const legacy = readStorage(API_KEY_LEGACY_KEY);
            if (legacy) {
                await SecureStorage.set(key, legacy);
                removeStorage(API_KEY_LEGACY_KEY);
                value = legacy;
            }
        }
        apiKeyCache = typeof value === "string" ? value : null;
    } catch (err) {
        console.error("mobile-runtime: failed to load API key:", err);
        apiKeyCache = null;
    }
}

/**
 * Store (or remove) the API key for the configured server in native secure
 * storage and update the in-memory cache. No-op on web.
 */
export async function setMobileApiKey(apiKey: string | null): Promise<void> {
    const { serverUrl } = getMobileRuntimeConfig();
    if (!serverUrl) return;
    const storage = await getSecureStorage();
    if (!storage) return;
    const SecureStorage = storage.plugin;

    const key = apiKeyStorageKey(serverUrl);
    try {
        if (apiKey) {
            await SecureStorage.set(key, apiKey);
            apiKeyCache = apiKey;
        } else {
            await SecureStorage.remove(key);
            apiKeyCache = null;
        }
    } catch (err) {
        console.error("mobile-runtime: failed to set API key:", err);
    }
}

/** Remove the API key for the configured server. No-op on web. */
export async function clearMobileApiKey(): Promise<void> {
    await setMobileApiKey(null);
}

/**
 * Initialize mobile runtime: if the bootstrap page passed a freshly redeemed
 * API key via the URL fragment, store it in secure storage and clear the
 * fragment; otherwise load any previously stored key. No-op on web.
 *
 * Call once before first render / installing the fetch patch.
 */
export async function initMobileRuntime(): Promise<void> {
    if (!nativeEnabled()) return;

    // A new key from the bootstrap page arrives as #pizzapi.apiKey=…
    // Capture + persist it FIRST, before the SW killswitch (which may reload),
    // so the key survives a reload even after the fragment is cleared.
    if (typeof window !== "undefined" && window.location && window.location.hash) {
        const params = new URLSearchParams(
            window.location.hash.startsWith("#")
                ? window.location.hash.slice(1)
                : window.location.hash,
        );
        const passedKey = params.get(HASH_API_KEY_PARAM);
        if (passedKey) {
            await setMobileApiKey(passedKey);
            // Clear the fragment so the key isn't visible in history.
            window.history.replaceState({}, "", window.location.pathname + window.location.search);
        }
    }

    // Kill any service worker in the native shell (may reload — must not return).
    await killNativeServiceWorker();

    if (apiKeyCache == null) await loadMobileApiKey();
}

/**
 * A service worker must never run inside the Capacitor WebView: the SW config is
 * root-oriented (scope "/", navigateFallback "/index.html") but the app is served
 * from /app/, so a stale precache serves cached HTML referencing old asset
 * hashes → blank/black screen after an app rebuild. New mobile builds don't ship
 * a SW (VITE_MOBILE disables PWA), but existing installs may already have one
 * registered — unregister it, drop its caches, and reload once for fresh assets.
 * Loop-safe: after unregister there is no controller, so no further reload.
 */
async function killNativeServiceWorker(): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    try {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length === 0) return;
        await Promise.all(regs.map((r) => r.unregister()));
        if (typeof caches !== "undefined") {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
        if (navigator.serviceWorker.controller) {
            window.location.reload();
            await new Promise<never>(() => {}); // halt boot until the reload takes over
        }
    } catch {
        // best-effort cleanup; never block boot
    }
}

/** Reset internal cache — exposed for tests. */
export function _resetMobileRuntimeCache(): void {
    apiKeyCache = null;
}

/** Set the internal API key cache directly — exposed for tests. */
export function _setMobileRuntimeCache(apiKey: string | null): void {
    apiKeyCache = apiKey;
}