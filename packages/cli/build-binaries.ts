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
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, rmSync } from "fs";
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

    // 4. templates/ — compose.yml.template for `pizza web`
    const templatesSrc = join(import.meta.dirname ?? __dirname, "src", "templates");
    if (existsSync(templatesSrc)) {
        cpSync(templatesSrc, join(outDir, "templates"), { recursive: true });
    }

    const cliDist = join(import.meta.dirname, "dist");
    const runnerDist = join(cliDist, "runner");
    const runnerSrc = join(import.meta.dirname, "src", "runner");
    const runnerSource = existsSync(runnerDist) ? runnerDist : runnerSrc;
    if (existsSync(runnerSource)) {
        cpSync(runnerSource, join(outDir, "runner"), { recursive: true });
    }

    // Always copy static assets from src first, then overlay compiled scripts
    // from dist if present. Using dist-only would miss static files (plugin.json,
    // skill markdown, etc.) that are never compiled into dist.
    const pluginDist = join(cliDist, "claude-code-plugin");
    const pluginSrc = join(import.meta.dirname, "src", "claude-code-plugin");
    if (existsSync(pluginSrc)) {
        cpSync(pluginSrc, join(outDir, "claude-code-plugin"), { recursive: true });
    }
    if (existsSync(pluginDist)) {
        cpSync(pluginDist, join(outDir, "claude-code-plugin"), { recursive: true });
    }
}

// ---------------------------------------------------------------------------
// Copy PTY native library
// ---------------------------------------------------------------------------

/**
 * Resolve the version of @zenyr/bun-pty platform packages by reading the
 * installed parent package metadata.
 */
function resolvePtyVersion(): string | null {
    // Try import.meta.resolve on the parent @zenyr/bun-pty package
    try {
        const entryUrl = import.meta.resolve("@zenyr/bun-pty");
        let dir = dirname(new URL(entryUrl).pathname);
        while (dir !== dirname(dir)) {
            const pkgPath = join(dir, "package.json");
            if (existsSync(pkgPath)) {
                const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
                if (pkg.name === "@zenyr/bun-pty") {
                    return pkg.version;
                }
            }
            dir = dirname(dir);
        }
    } catch {}

    // Fallback: scan Bun store for @zenyr+bun-pty@<version>
    for (const base of [join(import.meta.dirname, "node_modules"), join(import.meta.dirname, "..", "..", "node_modules")]) {
        const bunDir = join(base, ".bun");
        if (!existsSync(bunDir)) continue;
        try {
            for (const entry of readdirSync(bunDir)) {
                const m = entry.match(/^@zenyr\+bun-pty@(\d+\.\d+\.\d+)/);
                if (m) return m[1];
            }
        } catch {}
    }

    return null;
}

/**
 * Download the PTY native library for a target platform from the npm registry.
 * Used when the platform package isn't locally installed (cross-platform builds).
 */
async function downloadPtyLib(target: Target, outDir: string): Promise<boolean> {
    const pkgName = `bun-pty-${target.ptyOs}-${target.ptyCpu}`;
    const scopedName = `@zenyr/${pkgName}`;

    const version = resolvePtyVersion();
    if (!version) {
        console.log(`    ✗ Could not determine @zenyr/bun-pty version`);
        return false;
    }

    console.log(`    Downloading ${scopedName}@${version} from npm registry...`);

    const tmpDir = join(outDir, ".pty-download");
    mkdirSync(tmpDir, { recursive: true });

    try {
        // Fetch package metadata to get the tarball URL
        const metaResp = await fetch(`https://registry.npmjs.org/${scopedName}/${version}`);
        if (!metaResp.ok) {
            console.log(`    ✗ Failed to fetch package metadata (HTTP ${metaResp.status})`);
            return false;
        }
        const meta = (await metaResp.json()) as { dist?: { tarball?: string } };
        const tarballUrl = meta.dist?.tarball;
        if (!tarballUrl) {
            console.log(`    ✗ No tarball URL in package metadata`);
            return false;
        }

        // Download the tarball
        const tarResp = await fetch(tarballUrl);
        if (!tarResp.ok) {
            console.log(`    ✗ Failed to download tarball (HTTP ${tarResp.status})`);
            return false;
        }

        const tgzPath = join(tmpDir, `${pkgName}.tgz`);
        await Bun.write(tgzPath, tarResp);

        // Extract the tarball
        const result = await $`tar xzf ${tgzPath} -C ${tmpDir}`.nothrow().quiet();
        if (result.exitCode !== 0) {
            console.log(`    ✗ Failed to extract tarball`);
            return false;
        }

        // Copy the native library from the extracted package/ directory
        const libSrc = join(tmpDir, "package", target.ptyLibName);
        if (existsSync(libSrc)) {
            cpSync(libSrc, join(outDir, target.ptyLibName));
            return true;
        }

        console.log(`    ✗ ${target.ptyLibName} not found in downloaded package`);
        return false;
    } catch (err) {
        console.log(`    ✗ Download failed: ${err}`);
        return false;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Copy the @zenyr/bun-pty native shared library for the target platform
 * alongside the compiled binary.  At runtime the terminal worker sets
 * BUN_PTY_LIB pointing to this file so the FFI layer can find it.
 *
 * Tries three strategies in order:
 *   1. Resolve from locally installed platform package (host-matching targets)
 *   2. Search Bun's deduplicated node_modules store
 *   3. Download from the npm registry (cross-platform builds)
 */
async function copyPtyLib(target: Target, outDir: string): Promise<boolean> {
    const ptyPlatformPkg = `@zenyr/bun-pty-${target.ptyOs}-${target.ptyCpu}`;

    // Strategy 1: Try import.meta.resolve (works when the platform package is
    // installed for this host — i.e. target matches the build machine)
    try {
        const entryUrl = import.meta.resolve(ptyPlatformPkg);
        const pkgDir = dirname(new URL(entryUrl).pathname);
        const libSrc = join(pkgDir, target.ptyLibName);
        if (existsSync(libSrc)) {
            cpSync(libSrc, join(outDir, target.ptyLibName));
            return true;
        }
    } catch {}

    // Strategy 2: Search Bun's deduplicated store (node_modules/.bun/...)
    // Bun stores optional deps at node_modules/.bun/@scope+name@version/node_modules/@scope/name/
    const rootNodeModules = join(import.meta.dirname, "node_modules");
    const workspaceNodeModules = join(import.meta.dirname, "..", "..", "node_modules");
    for (const nmDir of [rootNodeModules, workspaceNodeModules]) {
        const bunDir = join(nmDir, ".bun");
        if (!existsSync(bunDir)) continue;
        try {
            for (const entry of readdirSync(bunDir)) {
                if (entry.startsWith("@zenyr+bun-pty-" + target.ptyOs + "-" + target.ptyCpu)) {
                    const libSrc = join(bunDir, entry, "node_modules", "@zenyr", `bun-pty-${target.ptyOs}-${target.ptyCpu}`, target.ptyLibName);
                    if (existsSync(libSrc)) {
                        cpSync(libSrc, join(outDir, target.ptyLibName));
                        return true;
                    }
                }
            }
        } catch {}
    }

    // Strategy 3: Download from npm registry (for cross-platform builds where
    // the host OS doesn't match the target and the platform package isn't installed)
    return await downloadPtyLib(target, outDir);
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

    if (await copyPtyLib(target, outDir)) {
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
