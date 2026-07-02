#!/usr/bin/env bun
/**
 * Remove node_modules from the native web asset bundles after `cap sync`.
 *
 * Capacitor copies the entire webDir ("mobile") into the native projects,
 * including mobile/node_modules — which under Bun are symlinks that dangle once
 * copied. Android lint (lintVitalRelease) then fails to read them, breaking
 * release builds, and they add needless bundle bloat. Nothing at runtime needs
 * node_modules (jsqr is vendored, happy-dom is test-only), so we strip them.
 *
 * ponytail: static list of the two known public dirs; add more if we ever
 * target another Capacitor platform.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const targets = [
    "android/app/src/main/assets/public/node_modules",
    "ios/App/App/public/node_modules",
];

for (const rel of targets) {
    rmSync(join(root, rel), { recursive: true, force: true });
}
console.log("Stripped node_modules from synced native asset bundles.");
