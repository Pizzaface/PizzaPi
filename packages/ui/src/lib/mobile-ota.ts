/**
 * Self-hosted OTA (over-the-air) web-bundle updates for the Capacitor app.
 *
 * The mobile app ships its UI baked into the APK. To deliver UI-only changes
 * without a store release, the relay server hosts the latest bundle (see
 * packages/server/src/routes/mobile-ota.ts). We run @capgo/capacitor-updater in
 * **manual mode**: the app's server URL is chosen at runtime (bootstrap page),
 * so Capgo's build-time `autoUpdate.updateUrl` can't be used — instead we fetch
 * the manifest ourselves, decide freshness, and drive download → set → reload.
 *
 * Freshness reuses the existing build-timestamp signal (the same one behind the
 * web "update available" banner): the manifest's `buildTimestamp` vs. the one
 * baked into the running bundle. ISO-8601 strings sort lexically, so a plain
 * `>` is a correct "strictly newer" test.
 *
 * Everything is a no-op outside the native Capacitor shell. The native plugin
 * is imported dynamically via a variable specifier so the web build never has
 * to resolve it (it's only installed for the mobile build + `cap sync`).
 *
 * ponytail: no retry/scheduler/progress UI — one check on launch. Add a
 * progress bar + periodic re-check only if bundles get large or updates frequent.
 */
import { Capacitor } from "@capacitor/core";
import { getMobileRuntimeConfig } from "./mobile-runtime.js";

/** Build timestamp baked into THIS bundle (the currently-installed version). */
declare const __PIZZAPI_BUILD_TIMESTAMP__: string;
const INSTALLED_BUILD_TIMESTAMP =
    typeof __PIZZAPI_BUILD_TIMESTAMP__ === "string" ? __PIZZAPI_BUILD_TIMESTAMP__ : "";

export interface OtaManifest {
    /** ISO-8601 build time of the published bundle — the freshness key. */
    buildTimestamp: string;
    /** Opaque version label handed to the native updater (we use the timestamp). */
    version: string;
    /** Bundle URL, relative to the server root, e.g. /api/mobile/ota/x.zip */
    url: string;
    /** SHA-256 hex of the zip; the native updater verifies it before applying. */
    checksum: string;
    /** Optional size in bytes (informational). */
    bytes?: number;
}

/**
 * Pure freshness decision: should the manifest replace the installed bundle?
 * Exported for tests — no side effects, no native access.
 */
export function shouldApplyOta(manifest: unknown, installedBuildTimestamp: string): boolean {
    if (!manifest || typeof manifest !== "object") return false;
    const m = manifest as Partial<OtaManifest>;
    return (
        typeof m.buildTimestamp === "string" &&
        typeof m.url === "string" &&
        !!m.url &&
        typeof m.checksum === "string" &&
        !!m.checksum &&
        m.buildTimestamp > installedBuildTimestamp
    );
}

/** True only inside the bundled native shell — web/PWA is always a no-op. */
function nativeEnabled(): boolean {
    return getMobileRuntimeConfig().isMobileBundled && Capacitor.isNativePlatform();
}

/** Minimal shape of the bits of @capgo/capacitor-updater we call. */
interface CapgoUpdater {
    notifyAppReady(): Promise<unknown>;
    download(opts: { url: string; version: string; checksum?: string }): Promise<{ id: string }>;
    set(bundle: { id: string }): Promise<unknown>;
    reload(): Promise<unknown>;
}

/**
 * Load the native updater. Dynamic + variable specifier so the web build/tsc
 * never needs the package resolved; returns null if unavailable.
 */
async function loadUpdater(): Promise<CapgoUpdater | null> {
    try {
        const spec = "@capgo/capacitor-updater";
        const mod = (await import(/* @vite-ignore */ spec)) as { CapacitorUpdater?: CapgoUpdater };
        return mod.CapacitorUpdater ?? null;
    } catch {
        return null;
    }
}

/**
 * Tell the updater this bundle booted successfully, cancelling the automatic
 * rollback that would otherwise revert a freshly-applied OTA bundle. Call once
 * on boot after the UI mounts. No-op on web.
 */
export async function notifyOtaReady(): Promise<void> {
    if (!nativeEnabled()) return;
    const updater = await loadUpdater();
    try {
        await updater?.notifyAppReady();
    } catch (err) {
        console.error("mobile-ota: notifyAppReady failed:", err);
    }
}

/**
 * Check the configured relay server for a newer bundle and, if found, download
 * + verify + apply it (which reloads the WebView into the new bundle). Returns
 * true when an update was applied. Best-effort and fully no-op on web.
 */
export async function checkAndApplyOtaUpdate(
    installedBuildTimestamp: string = INSTALLED_BUILD_TIMESTAMP,
): Promise<boolean> {
    if (!nativeEnabled()) return false;
    const { serverUrl } = getMobileRuntimeConfig();
    if (!serverUrl) return false;
    const base = serverUrl.replace(/\/+$/, "");

    let manifest: unknown;
    try {
        const res = await fetch(`${base}/api/mobile/ota/manifest.json`, { cache: "no-store" });
        if (!res.ok) return false;
        manifest = await res.json();
    } catch {
        return false; // offline / not configured — nothing to do
    }

    if (!shouldApplyOta(manifest, installedBuildTimestamp)) return false;
    const m = manifest as OtaManifest;

    const updater = await loadUpdater();
    if (!updater) return false;
    try {
        const bundle = await updater.download({
            url: m.url.startsWith("http") ? m.url : `${base}${m.url}`,
            version: m.version,
            checksum: m.checksum,
        });
        await updater.set(bundle);
        await updater.reload();
        return true;
    } catch (err) {
        console.error("mobile-ota: update failed:", err);
        return false;
    }
}
