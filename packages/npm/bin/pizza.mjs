#!/usr/bin/env node

/**
 * PizzaPi CLI launcher.
 *
 * This script locates the platform-specific binary installed via
 * optionalDependencies (or the postinstall fallback) and executes it,
 * passing through all arguments.
 *
 * Pattern borrowed from esbuild, turbo, swc, etc.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Map of `${process.platform}-${process.arch}` to npm package name
const PLATFORM_PACKAGES = {
    "linux-x64": "@pizzapi/cli-linux-x64",
    "linux-arm64": "@pizzapi/cli-linux-arm64",
    "darwin-x64": "@pizzapi/cli-darwin-x64",
    "darwin-arm64": "@pizzapi/cli-darwin-arm64",
    "win32-x64": "@pizzapi/cli-win32-x64",
};

const platformKey = `${process.platform}-${process.arch}`;
const pkgName = PLATFORM_PACKAGES[platformKey];

if (!pkgName) {
    console.error(
        `Error: PizzaPi does not have a prebuilt binary for your platform (${platformKey}).\n` +
            `Supported platforms: ${Object.keys(PLATFORM_PACKAGES).join(", ")}\n\n` +
            `You can build from source: https://github.com/Pizzaface/PizzaPi`,
    );
    process.exit(1);
}

/** Try to find the platform binary via multiple strategies. */
function findBinary() {
    const binName = process.platform === "win32" ? "pizza.exe" : "pizza";
    const parts = pkgName.split("/");

    // Strategy 1: require.resolve the platform package
    try {
        const require = createRequire(join(__dirname, "..", "package.json"));
        const pkgJson = require.resolve(`${pkgName}/package.json`);
        const pkgDir = dirname(pkgJson);
        const binPath = join(pkgDir, "bin", binName);
        if (existsSync(binPath)) return binPath;
    } catch {
        // not found via require
    }

    // Strategy 2: Sibling scoped package — both packages live under
    // node_modules/@pizzapi/, so the platform package is a sibling of ours.
    {
        const siblingPath = join(__dirname, "..", "..", parts[1], "bin", binName);
        if (existsSync(siblingPath)) return siblingPath;
    }

    // Strategy 3: Check common node_modules layouts (hoisted, nested)
    const searchRoots = [
        join(__dirname, "..", "node_modules"),
        join(__dirname, "..", "..", "node_modules"),
        join(__dirname, "..", "..", "..", "node_modules"),
    ];

    for (const root of searchRoots) {
        const binPath = join(root, parts[0], parts[1], "bin", binName);
        if (existsSync(binPath)) return binPath;
    }

    // Strategy 4: Walk up from __dirname looking for node_modules containing
    // the platform package (covers deeply nested or unusual layouts)
    {
        let dir = resolve(__dirname);
        for (let i = 0; i < 10; i++) {
            const candidate = join(dir, "node_modules", parts[0], parts[1], "bin", binName);
            if (existsSync(candidate)) return candidate;
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }

    return null;
}

const binaryPath = findBinary();

if (!binaryPath) {
    const parts = pkgName.split("/");
    const diag = [
        `  launcher: ${__filename}`,
        `  __dirname: ${__dirname}`,
        `  platform: ${platformKey}`,
    ];
    const siblingDir = join(__dirname, "..", "..", parts[1]);
    diag.push(`  sibling dir exists: ${existsSync(siblingDir)} (${siblingDir})`);

    console.error(
        `Error: Could not find the PizzaPi binary for your platform (${platformKey}).\n\n` +
            `The platform-specific package "${pkgName}" was not installed.\n\n` +
            `Install it manually:\n` +
            `  npm install -g ${pkgName}\n\n` +
            `Or reinstall PizzaPi:\n` +
            `  npm install -g @pizzapi/pizza\n\n` +
            `Or build from source: https://github.com/Pizzaface/PizzaPi\n\n` +
            `Diagnostics:\n${diag.join("\n")}`,
    );
    process.exit(1);
}

// Execute the binary with all arguments passed through
try {
    execFileSync(binaryPath, process.argv.slice(2), {
        stdio: "inherit",
        env: process.env,
    });
} catch (err) {
    // execFileSync throws on non-zero exit code; the child's output
    // is already piped to stdio so just propagate the exit code
    if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
        process.exit(err.status);
    }
    throw err;
}
