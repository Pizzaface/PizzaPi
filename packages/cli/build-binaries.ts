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
import { platform as osPlatform, arch as osArch } from "os";

// ---------------------------------------------------------------------------
// Platform targets
// ---------------------------------------------------------------------------

interface Target {
    id: string;
    bunTarget: string;
    exeName: string;
    /** OS name as used by @zenyr/bun-pty platform packages (e.g. "darwin") */
    ptyOs: string;
    /** CPU arch as used by @zenyr/bun-pty platform packages (e.g. "arm64") */
    ptyCpu: string;
    /** Native shared library filename for this platform */
    ptyLibName: string;
}

const ALL_TARGETS: Target[] = [
    { id: "linux-x64",   bunTarget: "bun-linux-x64",   exeName: "pizza-linux-x64",        ptyOs: "linux",  ptyCpu: "x64",   ptyLibName: "librust_pty.so" },
    { id: "linux-arm64", bunTarget: "bun-linux-arm64",  exeName: "pizza-linux-arm64",       ptyOs: "linux",  ptyCpu: "arm64", ptyLibName: "librust_pty_arm64.so" },
    { id: "macos-x64",   bunTarget: "bun-darwin-x64",   exeName: "pizza-macos-x64",        ptyOs: "darwin", ptyCpu: "x64",   ptyLibName: "librust_pty.dylib" },
    { id: "macos-arm64", bunTarget: "bun-darwin-arm64",  exeName: "pizza-macos-arm64",      ptyOs: "darwin", ptyCpu: "arm64", ptyLibName: "librust_pty_arm64.dylib" },
    { id: "windows-x64", bunTarget: "bun-windows-x64",  exeName: "pizza-windows-x64.exe",  ptyOs: "win32",  ptyCpu: "x64",   ptyLibName: "rust_pty.dll" },
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
// Copy PTY native library
// ---------------------------------------------------------------------------

/**
 * Copy the @zenyr/bun-pty native shared library for the target platform
 * alongside the compiled binary.  At runtime the terminal worker sets
 * BUN_PTY_LIB pointing to this file so the FFI layer can find it.
 *
 * We can only copy the library for the current host platform (the .dylib/.so
 * for other platforms isn't installed via optionalDependencies).
 */
function copyPtyLib(target: Target, outDir: string): boolean {
    // Only copy when we're building for the current host platform
    const hostOs = osPlatform();   // "darwin", "linux", "win32"
    const hostCpu = osArch();      // "arm64", "x64"
    if (target.ptyOs !== hostOs || target.ptyCpu !== hostCpu) {
        return false;
    }

    const ptyPlatformPkg = `@zenyr/bun-pty-${target.ptyOs}-${target.ptyCpu}`;
    try {
        const entryUrl = import.meta.resolve(ptyPlatformPkg);
        const pkgDir = dirname(new URL(entryUrl).pathname);
        const libSrc = join(pkgDir, target.ptyLibName);
        if (existsSync(libSrc)) {
            cpSync(libSrc, join(outDir, target.ptyLibName));
            return true;
        }
    } catch {}

    return false;
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

    if (copyPtyLib(target, outDir)) {
        console.log(`  ✓ PTY native library copied (${target.ptyLibName})`);
    } else {
        console.log(`  ⚠ PTY native library not available for ${target.ptyOs}-${target.ptyCpu} (cross-compile — must be added separately)`);
    }
}

if (failed) {
    process.exit(1);
}

console.log("\n✅ All binaries built successfully.");
console.log(`   Output: ${distBinaries}/`);
