#!/usr/bin/env bun
/**
 * Publishes all npm packages in packages/npm/dist/.
 *
 * Publishes platform-specific packages first, then the main pizzapi package.
 *
 * Usage:
 *   bun packages/npm/publish-npm.ts [--dry-run] [--tag <tag>]
 */

import { join } from "path";
import { readdirSync, existsSync, statSync } from "fs";

const DIST = join(import.meta.dirname, "dist");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagIdx = args.indexOf("--tag");
const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;

if (!existsSync(DIST)) {
    console.error("No dist/ directory found. Run `bun packages/npm/build-npm.ts` first.");
    process.exit(1);
}

const entries = readdirSync(DIST)
    .filter((name) => {
        const p = join(DIST, name);
        return statSync(p).isDirectory() && existsSync(join(p, "package.json"));
    })
    // Publish platform packages before the main package
    .sort((a, b) => {
        if (a === "pizzapi") return 1;
        if (b === "pizzapi") return -1;
        return a.localeCompare(b);
    });

if (entries.length === 0) {
    console.error("No packages found in dist/. Run the build first.");
    process.exit(1);
}

console.log(`Publishing ${entries.length} packages${dryRun ? " (dry run)" : ""}...\n`);

let failed = false;

for (const entry of entries) {
    const pkgDir = join(DIST, entry);
    const pkgJson = JSON.parse(
        require("fs").readFileSync(join(pkgDir, "package.json"), "utf-8"),
    );

    console.log(`▶ ${pkgJson.name}@${pkgJson.version}`);

    const npmArgs = ["publish"];
    if (dryRun) npmArgs.push("--dry-run");
    if (tag) npmArgs.push("--tag", tag);
    // access is set in publishConfig in each package.json

    const proc = Bun.spawnSync(["npm", ...npmArgs], {
        cwd: pkgDir,
        stdio: ["inherit", "inherit", "inherit"],
    });

    if (proc.exitCode !== 0) {
        console.error(`  ✗ Failed to publish ${pkgJson.name}`);
        failed = true;
    } else {
        console.log(`  ✓ Published`);
    }
    console.log();
}

if (failed) {
    console.error("Some packages failed to publish.");
    process.exit(1);
}

console.log("✅ All packages published successfully.");
