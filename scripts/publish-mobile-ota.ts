#!/usr/bin/env bun
/**
 * Publish the built mobile UI as a self-hosted OTA bundle.
 *
 * Zips `mobile/app/` (with index.html at the archive root, as Capgo requires),
 * computes its SHA-256, and writes `<out>/manifest.json` + `<out>/pizzapi-*.zip`
 * where `<out>` is PIZZAPI_MOBILE_OTA_DIR (default: repo `mobile-ota/`). Start
 * the relay server with the same PIZZAPI_MOBILE_OTA_DIR and it serves these at
 * /api/mobile/ota/* for the mobile client to fetch, verify, and apply.
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
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const appDir = join(root, "mobile", "app");
const outDir = process.env.PIZZAPI_MOBILE_OTA_DIR || join(root, "mobile-ota");

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

// Run from inside appDir so paths are relative → index.html sits at the zip
// root. -X drops platform extras for a reproducible archive.
await $`cd ${appDir} && zip -r -q -X ${zipPath} .`;

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
