#!/usr/bin/env bun
/**
 * Builds all npm packages for distribution.
 *
 * This script:
 * 1. Runs the binary builder to compile platform-specific binaries
 * 2. Populates platform-specific npm packages with the compiled binaries + assets
 * 3. Prepares the main `pizzapi` package
 *
 * After running, the packages in packages/npm/dist/ are ready to publish.
 *
 * Usage:
 *   bun packages/npm/build-npm.ts [--version <version>] [--skip-compile]
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, chmodSync } from "fs";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI_PKG = join(ROOT, "packages", "cli");
const NPM_PKG = join(ROOT, "packages", "npm");
const DIST = join(NPM_PKG, "dist");
const BINARIES_DIR = join(CLI_PKG, "dist", "binaries");

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const versionIdx = args.indexOf("--version");
const cliPkgJson = JSON.parse(readFileSync(join(CLI_PKG, "package.json"), "utf-8"));
const version = versionIdx !== -1 ? args[versionIdx + 1] : cliPkgJson.version;
const skipCompile = args.includes("--skip-compile");

// ---------------------------------------------------------------------------
// Platform definitions
// ---------------------------------------------------------------------------
interface Platform {
    /** npm package suffix, e.g. "linux-x64" */
    npmSuffix: string;
    /** Directory name in cli/dist/binaries/ */
    binaryDir: string;
    /** Binary filename in that directory */
    binaryName: string;
    /** Binary name in the npm package */
    binOutputName: string;
    /** npm os field */
    os: string;
    /** npm cpu field */
    cpu: string;
}

const PLATFORMS: Platform[] = [
    {
        npmSuffix: "linux-x64",
        binaryDir: "linux-x64",
        binaryName: "pizza-linux-x64",
        binOutputName: "pizza",
        os: "linux",
        cpu: "x64",
    },
    {
        npmSuffix: "linux-arm64",
        binaryDir: "linux-arm64",
        binaryName: "pizza-linux-arm64",
        binOutputName: "pizza",
        os: "linux",
        cpu: "arm64",
    },
    {
        npmSuffix: "darwin-x64",
        binaryDir: "macos-x64",
        binaryName: "pizza-macos-x64",
        binOutputName: "pizza",
        os: "darwin",
        cpu: "x64",
    },
    {
        npmSuffix: "darwin-arm64",
        binaryDir: "macos-arm64",
        binaryName: "pizza-macos-arm64",
        binOutputName: "pizza",
        os: "darwin",
        cpu: "arm64",
    },
    {
        npmSuffix: "win32-x64",
        binaryDir: "windows-x64",
        binaryName: "pizza-windows-x64.exe",
        binOutputName: "pizza.exe",
        os: "win32",
        cpu: "x64",
    },
];

// ---------------------------------------------------------------------------
// Step 1: Compile binaries (unless --skip-compile)
// ---------------------------------------------------------------------------
if (!skipCompile) {
    console.log("▶ Compiling platform binaries...\n");
    const proc = Bun.spawnSync(["bun", "run", "build:binaries"], {
        cwd: CLI_PKG,
        stdio: ["inherit", "inherit", "inherit"],
    });
    if (proc.exitCode !== 0) {
        console.error("\n✗ Binary compilation failed");
        process.exit(1);
    }
    console.log();
}

// ---------------------------------------------------------------------------
// Step 2: Clean dist
// ---------------------------------------------------------------------------
if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true });
}
mkdirSync(DIST, { recursive: true });

// ---------------------------------------------------------------------------
// Step 3: Build platform-specific packages
// ---------------------------------------------------------------------------
console.log("▶ Building platform-specific npm packages...\n");

for (const platform of PLATFORMS) {
    const pkgName = `@pizzapi/cli-${platform.npmSuffix}`;
    const pkgDir = join(DIST, `cli-${platform.npmSuffix}`);
    const binDir = join(pkgDir, "bin");

    mkdirSync(binDir, { recursive: true });

    // Copy binary
    const srcBinary = join(BINARIES_DIR, platform.binaryDir, platform.binaryName);
    if (!existsSync(srcBinary)) {
        console.warn(`  ⚠ Skipping ${pkgName}: binary not found at ${srcBinary}`);
        continue;
    }
    const destBinary = join(binDir, platform.binOutputName);
    cpSync(srcBinary, destBinary);
    if (platform.os !== "win32") {
        chmodSync(destBinary, 0o755);
    }

    // Copy assets (package.json from pi, theme/, export-html/)
    const assetDir = join(BINARIES_DIR, platform.binaryDir);
    for (const asset of ["package.json", "theme", "export-html"]) {
        const src = join(assetDir, asset);
        if (existsSync(src)) {
            cpSync(src, join(binDir, asset), { recursive: true });
        }
    }

    // Write package.json
    const pkg = {
        name: pkgName,
        version,
        description: `PizzaPi CLI binary for ${platform.os}-${platform.cpu}`,
        license: "MIT",
        os: [platform.os],
        cpu: [platform.cpu],
        bin: {
            pizza: `bin/${platform.binOutputName}`,
        },
        files: ["bin/"],
        publishConfig: {
            access: "public",
        },
    };
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

    // Write README
    writeFileSync(
        join(pkgDir, "README.md"),
        `# ${pkgName}\n\nPlatform-specific binary for PizzaPi CLI (${platform.os}/${platform.cpu}).\n\nThis package is installed automatically by the \`pizzapi\` package. You don't need to install it directly.\n`,
    );

    console.log(`  ✓ ${pkgName}`);
}

// ---------------------------------------------------------------------------
// Step 4: Build the main pizzapi package
// ---------------------------------------------------------------------------
console.log("\n▶ Building main pizzapi package...\n");

const mainPkgDir = join(DIST, "pizzapi");
const mainBinDir = join(mainPkgDir, "bin");
mkdirSync(mainBinDir, { recursive: true });

// Build optionalDependencies map
const optionalDeps: Record<string, string> = {};
for (const platform of PLATFORMS) {
    optionalDeps[`@pizzapi/cli-${platform.npmSuffix}`] = version;
}

// Main package.json
const mainPkg = {
    name: "@pizzapi/pizza",
    version,
    description:
        "PizzaPi — a self-hosted web interface and relay server for the pi coding agent. Stream live AI coding sessions to any browser.",
    license: "MIT",
    bin: {
        pizza: "bin/pizza.mjs",
        pizzapi: "bin/pizza.mjs",
    },
    files: ["bin/", "README.md", "LICENSE"],
    optionalDependencies: optionalDeps,
    engines: {
        node: ">=18",
    },
    keywords: [
        "ai",
        "coding-agent",
        "cli",
        "pi",
        "pizzapi",
        "llm",
        "anthropic",
        "claude",
        "gemini",
    ],
    repository: {
        type: "git",
        url: "git+https://github.com/Pizzaface/PizzaPi.git",
    },
    homepage: "https://github.com/Pizzaface/PizzaPi",
    publishConfig: {
        access: "public",
    },
};
writeFileSync(join(mainPkgDir, "package.json"), JSON.stringify(mainPkg, null, 2) + "\n");

// Copy the launcher bin script
cpSync(join(NPM_PKG, "bin", "pizza.mjs"), join(mainBinDir, "pizza.mjs"));
chmodSync(join(mainBinDir, "pizza.mjs"), 0o755);

// Copy README if exists, otherwise generate one
const readmeSrc = join(NPM_PKG, "README.md");
if (existsSync(readmeSrc)) {
    cpSync(readmeSrc, join(mainPkgDir, "README.md"));
}

// Copy LICENSE from root if exists
const licenseSrc = join(ROOT, "LICENSE");
if (existsSync(licenseSrc)) {
    cpSync(licenseSrc, join(mainPkgDir, "LICENSE"));
}

console.log("  ✓ pizzapi\n");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("✅ All npm packages built successfully.");
console.log(`   Output: ${DIST}/`);
console.log(`   Version: ${version}`);
console.log(`\nTo publish:`);
console.log(`   cd ${DIST}/cli-<platform> && npm publish`);
console.log(`   cd ${DIST}/pizzapi && npm publish`);
console.log(`\nOr use: bun packages/npm/publish-npm.ts`);
