#!/usr/bin/env bun
/**
 * Builds self-contained `pizza` binaries for all supported platforms.
 *
 * Each binary is placed in dist/binaries/<platform>/ alongside the asset
 * files that @mariozechner/pi-coding-agent expects to find next to the
 * executable at runtime (package.json, theme/, export-html/).
 *
 * Usage:
 *   bun build-binaries.ts [--target <target>]
 *
 * Targets: linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64
 * Omit --target to build all platforms.
 */

import { $ } from "bun";
import { join, dirname } from "path";
import { existsSync, mkdirSync, cpSync } from "fs";

// ---------------------------------------------------------------------------
// Platform targets
// ---------------------------------------------------------------------------

interface Target {
    id: string;
    bunTarget: string;
    exeName: string;
}

const ALL_TARGETS: Target[] = [
    { id: "linux-x64",   bunTarget: "bun-linux-x64",   exeName: "pizza-linux-x64" },
    { id: "linux-arm64", bunTarget: "bun-linux-arm64",  exeName: "pizza-linux-arm64" },
    { id: "macos-x64",   bunTarget: "bun-darwin-x64",   exeName: "pizza-macos-x64" },
    { id: "macos-arm64", bunTarget: "bun-darwin-arm64",  exeName: "pizza-macos-arm64" },
    { id: "windows-x64", bunTarget: "bun-windows-x64",  exeName: "pizza-windows-x64.exe" },
];

// ---------------------------------------------------------------------------
// Resolve pi-coding-agent package root (needed to copy assets)
// ---------------------------------------------------------------------------

function resolvePiPackageDir(): string {
    // import.meta.resolve gives us the main entry point URL; walk up to find package.json
    const entryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
    let dir = dirname(new URL(entryUrl).pathname);
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) {
            return dir;
        }
        dir = dirname(dir);
    }
    throw new Error("Could not locate @mariozechner/pi-coding-agent package root");
}

// ---------------------------------------------------------------------------
// Copy runtime assets
// ---------------------------------------------------------------------------

function copyAssets(piPkgDir: string, outDir: string): void {
    // 1. package.json — read at module load time via readFileSync
    cpSync(join(piPkgDir, "package.json"), join(outDir, "package.json"));

    // 2. theme/ — built-in UI themes (dark.json, light.json, theme-schema.json)
    const themeSrc = join(piPkgDir, "dist", "modes", "interactive", "theme");
    if (existsSync(themeSrc)) {
        cpSync(themeSrc, join(outDir, "theme"), { recursive: true });
    }

    // 3. export-html/ — HTML export template
    const exportSrc = join(piPkgDir, "dist", "core", "export-html");
    if (existsSync(exportSrc)) {
        cpSync(exportSrc, join(outDir, "export-html"), { recursive: true });
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const targetFlag = args.indexOf("--target");
const requestedId = targetFlag !== -1 ? args[targetFlag + 1] : undefined;

const targets = requestedId
    ? ALL_TARGETS.filter((t) => t.id === requestedId)
    : ALL_TARGETS;

if (targets.length === 0) {
    console.error(`Unknown target "${requestedId}". Valid targets: ${ALL_TARGETS.map((t) => t.id).join(", ")}`);
    process.exit(1);
}

const piPkgDir = resolvePiPackageDir();
console.log(`Resolved pi-coding-agent at: ${piPkgDir}`);

const entrypoint = join(import.meta.dirname, "src", "index.ts");
const distBinaries = join(import.meta.dirname, "dist", "binaries");

let failed = false;

for (const target of targets) {
    const outDir = join(distBinaries, target.id);
    const outFile = join(outDir, target.exeName);

    mkdirSync(outDir, { recursive: true });

    console.log(`\n▶ Building ${target.id} → ${outFile}`);

    const result = await $`bun build --compile --target=${target.bunTarget} ${entrypoint} --outfile ${outFile}`.nothrow();

    if (result.exitCode !== 0) {
        console.error(`  ✗ Build failed for ${target.id}`);
        failed = true;
        continue;
    }

    console.log(`  ✓ Compiled`);

    copyAssets(piPkgDir, outDir);
    console.log(`  ✓ Assets copied`);
}

if (failed) {
    process.exit(1);
}

console.log("\n✅ All binaries built successfully.");
console.log(`   Output: ${distBinaries}/`);
