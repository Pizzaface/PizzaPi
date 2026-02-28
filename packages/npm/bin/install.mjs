#!/usr/bin/env node

/**
 * PizzaPi postinstall script.
 *
 * Runs after `npm install @pizzapi/pizza` to ensure the platform-specific
 * binary package is present **and at the correct version**.
 *
 * npm doesn't always install optionalDependencies reliably — especially with
 * nvm-windows, global installs, or when the lockfile is stale (npm/cli#4828).
 * Even when the binary exists, a stale platform package from a previous
 * version can linger after an upgrade, causing hard-to-debug issues.
 *
 * Strategy:
 *   1. Locate the platform binary package
 *   2. If missing OR its version doesn't match @pizzapi/pizza, (re)install it
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

/** Read our own version from @pizzapi/pizza's package.json. */
function getOwnVersion() {
    try {
        return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
    } catch {
        return undefined;
    }
}

/**
 * Find the platform package's directory.
 * Returns the path to its package.json directory, or null if not found.
 */
function findPlatformPkgDir() {
    const parts = pkgName.split("/");

    // Strategy 1: require.resolve
    try {
        const require = createRequire(join(__dirname, "..", "package.json"));
        const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
        return dirname(pkgJsonPath);
    } catch {}

    // Strategy 2: sibling scoped package
    {
        const siblingDir = join(__dirname, "..", "..", parts[1]);
        const siblingPkg = join(siblingDir, "package.json");
        if (existsSync(siblingPkg)) return siblingDir;
    }

    // Strategy 3: walk up looking for node_modules
    {
        let dir = __dirname;
        for (let i = 0; i < 10; i++) {
            const candidate = join(dir, "node_modules", parts[0], parts[1]);
            const candidatePkg = join(candidate, "package.json");
            if (existsSync(candidatePkg)) return candidate;
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }

    return null;
}

/**
 * Check that the platform binary exists AND its version matches ours.
 * Returns: "ok" | "missing" | "stale"
 */
function checkPlatformPackage() {
    const pkgDir = findPlatformPkgDir();
    if (!pkgDir) return "missing";

    // Verify binary file exists
    const binName = process.platform === "win32" ? "pizza.exe" : "pizza";
    const binPath = join(pkgDir, "bin", binName);
    if (!existsSync(binPath)) return "missing";

    // Verify version matches
    const ownVersion = getOwnVersion();
    if (!ownVersion) return "ok"; // can't check — assume fine

    try {
        const platformPkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
        if (platformPkg.version !== ownVersion) {
            return "stale";
        }
    } catch {
        // Can't read — assume stale to be safe
        return "stale";
    }

    return "ok";
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

/** Run package manager install command. */
function installPlatformPackage(versionSpec, pm, isGlobal) {
    if (pm === "yarn") {
        const cmd = isGlobal ? `yarn global add ${versionSpec}` : `yarn add ${versionSpec}`;
        execSync(cmd, { stdio: "inherit", env: process.env });
    } else if (pm === "pnpm") {
        const flag = isGlobal ? " -g" : "";
        execSync(`pnpm add${flag} ${versionSpec}`, { stdio: "inherit", env: process.env });
    } else if (pm === "bun") {
        const flag = isGlobal ? " -g" : "";
        execSync(`bun add${flag} ${versionSpec}`, { stdio: "inherit", env: process.env });
    } else {
        // npm
        const flag = isGlobal ? " -g" : "";
        execSync(`npm install${flag} ${versionSpec}`, { stdio: "inherit", env: process.env });
    }
}

// --- Main ---

const status = checkPlatformPackage();

if (status === "ok") {
    // Binary exists and version matches — nothing to do
    process.exit(0);
}

const version = getOwnVersion();
const versionSpec = version ? `${pkgName}@${version}` : pkgName;
const pm = detectPackageManager();
const isGlobal = isGlobalInstall();

if (status === "stale") {
    console.log(`[pizzapi] Platform package ${pkgName} is outdated (expected ${version}).`);
    console.log(`[pizzapi] Upgrading with ${pm}...`);
} else {
    console.log(`[pizzapi] Platform package ${pkgName} was not installed automatically.`);
    console.log(`[pizzapi] Installing with ${pm}...`);
}

try {
    installPlatformPackage(versionSpec, pm, isGlobal);

    const postStatus = checkPlatformPackage();
    if (postStatus === "ok") {
        console.log(`[pizzapi] Successfully installed ${pkgName}@${version}.`);
    } else if (postStatus === "stale") {
        // Installed but still wrong version — try removing first then reinstalling
        console.log(`[pizzapi] Version mismatch persists — removing stale package and retrying...`);
        try {
            if (pm === "npm") {
                const flag = isGlobal ? " -g" : "";
                execSync(`npm rm${flag} ${pkgName}`, { stdio: "inherit", env: process.env });
            }
            installPlatformPackage(versionSpec, pm, isGlobal);
        } catch {}

        if (checkPlatformPackage() === "ok") {
            console.log(`[pizzapi] Successfully installed ${pkgName}@${version}.`);
        } else {
            throw new Error("Version mismatch after reinstall");
        }
    } else {
        throw new Error("Binary not found after install");
    }
} catch (err) {
    console.error(`[pizzapi] Failed to install ${pkgName}@${version} automatically.`);
    console.error(`[pizzapi] Please install it manually:`);
    if (isGlobal) {
        console.error(`[pizzapi]   npm rm -g ${pkgName} && npm install -g ${versionSpec}`);
    } else {
        console.error(`[pizzapi]   npm install ${versionSpec}`);
    }
    // Don't fail the overall install — this is best-effort
    process.exit(0);
}
