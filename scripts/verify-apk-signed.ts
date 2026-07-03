#!/usr/bin/env bun
/**
 * Fail the build unless the release APK is actually signed.
 *
 * Gradle silently emits `app-release-unsigned.apk` when no signingConfig is
 * active (missing PIZZAPI_KEYSTORE_* env vars), which installs nowhere and is
 * useless for distribution. This is the "ensure we sign" gate: a release build
 * that isn't signed exits non-zero instead of shipping a dud.
 *
 * When the Android SDK's apksigner is on hand we also verify the signature and
 * print the signing certificate; otherwise the signed-vs-unsigned filename check
 * alone is the guarantee.
 */
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const releaseDir = join(import.meta.dir, "..", "android", "app", "build", "outputs", "apk", "release");
const signed = join(releaseDir, "app-release.apk");
const unsigned = join(releaseDir, "app-release-unsigned.apk");

if (!existsSync(signed)) {
    const hint = existsSync(unsigned)
        ? `Found ${unsigned} instead — the build produced an UNSIGNED APK.\n` +
          "Set PIZZAPI_KEYSTORE_FILE / PIZZAPI_KEYSTORE_PASSWORD / PIZZAPI_KEY_ALIAS / PIZZAPI_KEY_PASSWORD before building."
        : `No release APK at ${signed}. Did 'gradlew assembleRelease' run?`;
    console.error(`✗ Release APK is not signed.\n${hint}`);
    process.exit(1);
}

// ponytail: apksigner verification is required for release integrity. If the
// Android SDK build-tools are unavailable the gate fails closed so we never
// ship an APK whose signature has not been checked.
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const apksigner = sdk ? findApksigner(join(sdk, "build-tools")) : null;
if (!apksigner) {
    console.error("✗ apksigner not found — release signature verification cannot run.");
    console.error("  Install Android SDK build-tools and set ANDROID_HOME (or ANDROID_SDK_ROOT).");
    console.error("  Example: sdkmanager 'build-tools;35.0.0'");
    process.exit(1);
}

try {
    const out = execFileSync(apksigner, ["verify", "--print-certs", signed], { encoding: "utf8" });
    console.log(out.trim());
} catch (err) {
    console.error(`✗ apksigner could not verify ${signed}:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}

console.log(`✓ Signed release APK: ${signed}`);

/** Pick apksigner from the highest build-tools version present. */
function findApksigner(buildToolsDir: string): string | null {
    if (!existsSync(buildToolsDir)) return null;
    const versions = readdirSync(buildToolsDir).sort().reverse();
    for (const v of versions) {
        const p = join(buildToolsDir, v, "apksigner");
        if (existsSync(p)) return p;
    }
    return null;
}
