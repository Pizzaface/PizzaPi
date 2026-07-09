/**
 * Mobile OTA router — serves the self-hosted Capacitor live-update bundle.
 *
 * The mobile app loads its UI from bundled assets baked into the APK. To ship
 * UI-only changes without a new APK, the relay server (which the app already
 * trusts) hosts the latest web bundle as a checksummed zip plus a small
 * manifest. The mobile client (see packages/ui/src/lib/mobile-ota.ts) fetches
 * the manifest, compares build timestamps, and — via @capgo/capacitor-updater
 * in manual mode — downloads + verifies + swaps the bundle.
 *
 * Endpoints (unauthenticated by design — the bundle is the same public UI the
 * server already serves; integrity is guaranteed by the SHA-256 the client
 * passes to the native updater, not by access control):
 *   GET /api/mobile/ota/manifest.json  → the manifest, or 404 when unpublished
 *   GET /api/mobile/ota/<name>.zip      → a published bundle zip, or 404
 *
 * The published files live in PIZZAPI_MOBILE_OTA_DIR. When that env var is
 * unset the feature is simply off (every path 404s).
 *
 * ponytail: static-file serve + traversal guard, no DB/state. Add auth/signing
 * only if bundles ever contain non-public data (they don't today).
 */

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { RouteHandler } from "./types.js";

const OTA_PREFIX = "/api/mobile/ota/";

/** Resolve the configured OTA directory, or null when the feature is off. */
function otaDir(): string | null {
    const dir = process.env.PIZZAPI_MOBILE_OTA_DIR;
    if (!dir) return null;
    const resolved = resolve(dir);
    return existsSync(resolved) ? resolved : null;
}

export const handleMobileOtaRoute: RouteHandler = async (req, url) => {
    if (!url.pathname.startsWith(OTA_PREFIX)) return undefined;
    if (req.method !== "GET") return undefined;

    const dir = otaDir();
    if (!dir) return new Response("OTA not configured", { status: 404 });

    // Only ever serve the manifest or *.zip bundles — never anything else.
    const name = url.pathname.slice(OTA_PREFIX.length);
    const isManifest = name === "manifest.json";
    const isBundle = /^[A-Za-z0-9._-]+\.zip$/.test(name);
    if (!isManifest && !isBundle) return new Response("Not found", { status: 404 });

    // Path-traversal guard: the resolved file must stay inside the OTA dir.
    const filePath = resolve(dir, name);
    const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
    if (!filePath.startsWith(dirWithSep)) return new Response("Not found", { status: 404 });

    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });

    return new Response(file, {
        headers: {
            "content-type": isManifest ? "application/json; charset=utf-8" : "application/zip",
            // Manifest must never be cached (freshness check); bundles are
            // content-addressed by name so they can cache forever.
            "cache-control": isManifest ? "no-cache" : "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
        },
    });
};
