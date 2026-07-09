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

const manifest = {
    buildTimestamp,
    version: buildTimestamp,
    url: `/api/mobile/ota/${zipName}`,
    checksum,
    bytes: buf.length,
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
