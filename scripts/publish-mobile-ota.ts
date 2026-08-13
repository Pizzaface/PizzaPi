#!/usr/bin/env bun
/**
 * Publish the built mobile UI as a self-hosted OTA bundle.
 *
 * Zips the Capacitor web root (`webDir: "mobile"`) so the OTA bundle mirrors
 * exactly what the APK ships: `index.html` (the bootstrap/reconfiguration shell
 * that redirects to `./app/index.html`) + `app/` (the built UI) + `vendor/`
 * (jsqr for the QR scanner). Zipping only `app/` would drop the bootstrap shell,
 * so after an OTA the app would boot straight into the UI and lose the
 * server-setup / sign-out / re-pair flow. Dev files (package.json, tests,
 * node_modules) are excluded. index.html sits at the archive root, as Capgo
 * requires. buildTimestamp still comes from `app/build-info.json`.
 *
 * Writes `<out>/manifest.json` + `<out>/pizzapi-*.zip` where `<out>` is
 * PIZZAPI_MOBILE_OTA_DIR (default: repo `mobile-ota/`). Start the relay server
 * with the same PIZZAPI_MOBILE_OTA_DIR and it serves these at /api/mobile/ota/*
 * for the mobile client to fetch, verify, and apply.
 *
 * Prereq: `bun run build:mobile` (produces mobile/app/). Requires the system
 * `zip` tool.
 *
 * Kill-switch: set PIZZAPI_MOBILE_OTA_MIN_BUILD_TIMESTAMP when publishing a
 * fix to include a `minBuildTimestamp` floor in the new manifest, or — to
 * strand an already-published bad bundle *without* a rebuild — run:
 *
 *   PIZZAPI_MOBILE_OTA_DIR=/srv/pizzapi-ota bun scripts/publish-mobile-ota.ts \
 *     --kill-switch=2026-07-10T00:00:00.000Z
 *
 * which patches minBuildTimestamp on the existing manifest.json in place (the
 * zip/checksum/buildTimestamp are untouched). Clients refuse that bundle until
 * a bundle with buildTimestamp >= the kill-switch timestamp is published.
 *
 * ponytail: no staged rollout percentages, no rollback UI, no signed bundles —
 * the kill-switch is the whole mitigation. See docs/mobile-ota.md.
 *
 * ponytail: system `zip` + node:crypto, no new deps. If a device ever rejects
 * the archive, swap the zip step for `@capgo/cli bundle zip` (their format).
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const webDir = join(root, "mobile");
const appDir = join(webDir, "app");
// Resolve to absolute: the zip step runs after `cd ${appDir}`, so a relative
// outDir would otherwise be written under mobile/app and then not found.
const outDir = resolve(process.env.PIZZAPI_MOBILE_OTA_DIR || join(root, "mobile-ota"));

// --kill-switch=<ISO-8601 timestamp>: patch minBuildTimestamp on the existing
// manifest without rebuilding/rezipping. This is the fast path for stranding
// an already-published bad bundle.
const killSwitchArg = process.argv.slice(2).find((a) => a.startsWith("--kill-switch="));
if (killSwitchArg) {
    const minBuildTimestamp = killSwitchArg.slice("--kill-switch=".length);
    if (!minBuildTimestamp) {
        console.error("--kill-switch requires a value, e.g. --kill-switch=2026-07-10T00:00:00.000Z");
        process.exit(1);
    }
    const manifestPath = join(outDir, "manifest.json");
    if (!existsSync(manifestPath)) {
        console.error(`No manifest at ${manifestPath} — publish a bundle first.`);
        process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.minBuildTimestamp = minBuildTimestamp;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
        `Kill-switch set on ${manifestPath}:\n` +
            `  minBuildTimestamp = ${minBuildTimestamp}\n` +
            `Clients will refuse bundle ${String(manifest.buildTimestamp ?? "(unknown)")} until a bundle with a ` +
            `buildTimestamp >= ${minBuildTimestamp} is published.`,
    );
    process.exit(0);
}

if (!existsSync(join(appDir, "index.html"))) {
    console.error(`No built mobile UI at ${appDir}.\nRun: bun run build:mobile`);
    process.exit(1);
}

const info = JSON.parse(readFileSync(join(appDir, "build-info.json"), "utf8")) as {
    buildTimestamp?: string;
};
const buildTimestamp = info.buildTimestamp;
if (!buildTimestamp) {
    console.error("mobile/app/build-info.json is missing buildTimestamp");
    process.exit(1);
}

const slug = buildTimestamp.replace(/[:.]/g, "-");
const zipName = `pizzapi-${slug}.zip`;

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, zipName);
rmSync(zipPath, { force: true });

// Zip the served webDir structure (index.html at root + app/ + vendor/) so the
// bootstrap shell survives OTA. Explicit entries exclude dev files/node_modules.
// -X drops platform extras for a reproducible archive.
const entries = ["index.html", "app"];
if (existsSync(join(webDir, "vendor"))) entries.push("vendor");
await $`cd ${webDir} && zip -r -q -X ${zipPath} ${entries}`;

const buf = readFileSync(zipPath);
const checksum = createHash("sha256").update(buf).digest("hex");

// Optional kill-switch floor to set on this newly-published (good) manifest —
// e.g. after a fix, PIZZAPI_MOBILE_OTA_MIN_BUILD_TIMESTAMP=<bad build's ts>
// makes explicit that nothing older is ever eligible again. Optional/absent
// by default so normal publishes are unaffected.
const minBuildTimestamp = process.env.PIZZAPI_MOBILE_OTA_MIN_BUILD_TIMESTAMP;
const manifest = {
    buildTimestamp,
    version: buildTimestamp,
    url: `/api/mobile/ota/${zipName}`,
    checksum,
    bytes: buf.length,
    ...(minBuildTimestamp ? { minBuildTimestamp } : {}),
};
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Cheap self-check: a valid sha-256 is 64 hex chars and the zip is non-empty.
if (checksum.length !== 64 || buf.length === 0) {
    console.error("Publish produced an invalid bundle/checksum");
    process.exit(1);
}

console.log(
    `Published OTA bundle:\n` +
        `  ${zipPath} (${buf.length} bytes)\n` +
        `  sha256 ${checksum}\n` +
        `  ${join(outDir, "manifest.json")}\n\n` +
        `Serve it: start the server with PIZZAPI_MOBILE_OTA_DIR=${outDir}`,
);
