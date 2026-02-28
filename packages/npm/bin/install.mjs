#!/usr/bin/env node

/**
 * PizzaPi postinstall script.
 *
 * Runs after `npm install @pizzapi/pizza` to ensure the platform-specific
 * binary package is present. npm doesn't always install optionalDependencies
 * reliably — especially with nvm-windows, global installs, or when the
 * lockfile is stale (npm/cli#4828).
 *
 * Strategy:
 *   1. Check if the platform binary already exists (optionalDeps worked)
 *   2. If not, invoke the user's package manager to install it
 *
 * This mirrors the approach used by esbuild, rollup, swc, etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    // Unsupported platform — nothing we can do at install time
    process.exit(0);
}

function getOwnVersion() {
    try {
        return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
    } catch {
        return undefined;
    }
}

/** Check if the platform binary is already installed. */
function binaryExists() {
    const binName = process.platform === "win32" ? "pizza.exe" : "pizza";
    const parts = pkgName.split("/");

    // Check via require.resolve
    try {
        const require = createRequire(join(__dirname, "..", "package.json"));
        const pkgJson = require.resolve(`${pkgName}/package.json`);
        const binPath = join(dirname(pkgJson), "bin", binName);
        if (existsSync(binPath)) return true;
    } catch {}

    // Check sibling scoped package
    {
        const siblingPath = join(__dirname, "..", "..", parts[1], "bin", binName);
        if (existsSync(siblingPath)) return true;
    }

    // Walk up looking for node_modules
    {
        let dir = __dirname;
        for (let i = 0; i < 10; i++) {
            const candidate = join(dir, "node_modules", parts[0], parts[1], "bin", binName);
            if (existsSync(candidate)) return true;
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }

    return false;
}

/** Detect the package manager that invoked this install. */
function detectPackageManager() {
    const ua = process.env.npm_config_user_agent || "";
    if (ua.startsWith("yarn")) return "yarn";
    if (ua.startsWith("pnpm")) return "pnpm";
    if (ua.startsWith("bun")) return "bun";
    return "npm";
}

/** Check if this is a global install. */
function isGlobalInstall() {
    // npm sets this env var during global installs
    if (process.env.npm_config_global === "true") return true;
    // Heuristic: check if we're inside a global-looking path
    const globalMarkers = ["node_modules/.global", "nvm", "volta", "fnm", "nodenv"];
    const loc = __dirname.toLowerCase();
    if (loc.includes("lib/node_modules") || loc.includes("lib\\node_modules")) return true;
    for (const marker of globalMarkers) {
        if (loc.includes(marker)) return true;
    }
    return false;
}

// --- Main ---

if (binaryExists()) {
    // All good — optionalDependencies did its job
    process.exit(0);
}

const version = getOwnVersion();
const versionSpec = version ? `${pkgName}@${version}` : pkgName;
const pm = detectPackageManager();
const global = isGlobalInstall();

console.log(`[pizzapi] Platform package ${pkgName} was not installed automatically.`);
console.log(`[pizzapi] Installing with ${pm}...`);

try {
    if (pm === "yarn") {
        const cmd = global ? `yarn global add ${versionSpec}` : `yarn add ${versionSpec}`;
        execSync(cmd, { stdio: "inherit", env: process.env });
    } else if (pm === "pnpm") {
        const flag = global ? " -g" : "";
        execSync(`pnpm add${flag} ${versionSpec}`, { stdio: "inherit", env: process.env });
    } else if (pm === "bun") {
        const flag = global ? " -g" : "";
        execSync(`bun add${flag} ${versionSpec}`, { stdio: "inherit", env: process.env });
    } else {
        // npm
        const flag = global ? " -g" : "";
        execSync(`npm install${flag} ${versionSpec}`, { stdio: "inherit", env: process.env });
    }

    if (binaryExists()) {
        console.log(`[pizzapi] Successfully installed ${pkgName}.`);
    } else {
        throw new Error("Binary not found after install");
    }
} catch (err) {
    console.error(`[pizzapi] Failed to install ${pkgName} automatically.`);
    console.error(`[pizzapi] Please install it manually:`);
    if (global) {
        console.error(`[pizzapi]   npm install -g ${versionSpec}`);
    } else {
        console.error(`[pizzapi]   npm install ${versionSpec}`);
    }
    // Don't fail the overall install — this is best-effort
    process.exit(0);
}
