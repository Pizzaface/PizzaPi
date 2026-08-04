#!/usr/bin/env bun
/**
 * Assembles the Docker build context for the PizzaPi runner image.
 *
 * The repo-root .dockerignore excludes packages/cli and docker/, so a
 * root-context build can't see the standalone binaries. This script builds
 * (or reuses) them via build-binaries.ts and copies just what the runner
 * Dockerfile needs into a small, self-contained directory:
 *
 *   <out>/linux-x64/…      binary (renamed to `pizza`) + libs + assets
 *   <out>/linux-arm64/…
 *   <out>/seccomp/x64/{apply-seccomp,unix-block.bpf}
 *   <out>/seccomp/arm64/{apply-seccomp,unix-block.bpf}
 *   <out>/entrypoint.sh
 *
 * Usage:
 *   bun docker/runner/stage-context.ts [--targets linux-x64,linux-arm64] [--skip-build] [--out <dir>]
 */

import { $ } from "bun";
import { join, dirname } from "path";
import { existsSync, mkdirSync, cpSync, readdirSync } from "fs";

const SECCOMP_ARCH_MAP: Record<string, "x64" | "arm64"> = {
    "linux-x64": "x64",
    "linux-arm64": "arm64",
};

function parseArgs() {
    const args = process.argv.slice(2);
    const targetsFlag = args.indexOf("--targets");
    const outFlag = args.indexOf("--out");
    const targets = targetsFlag !== -1
        ? args[targetsFlag + 1].split(",").map((t) => t.trim()).filter(Boolean)
        : ["linux-x64", "linux-arm64"];
    for (const t of targets) {
        if (!(t in SECCOMP_ARCH_MAP)) {
            console.error(`Unknown target "${t}". Valid targets: ${Object.keys(SECCOMP_ARCH_MAP).join(", ")}`);
            process.exit(1);
        }
    }
    return {
        targets,
        skipBuild: args.includes("--skip-build"),
        out: outFlag !== -1 ? args[outFlag + 1] : join(import.meta.dirname, "..", "..", "packages", "cli", "dist", "runner-image-context"),
    };
}

/**
 * Resolve @anthropic-ai/sandbox-runtime's package root, the same way
 * build-binaries.ts resolves pi-coding-agent. It's only a dependency of
 * packages/tools (not hoisted to the workspace root), so resolve relative
 * to that package rather than this script's own location.
 */
function resolveSandboxRuntimeDir(): string {
    const fromDir = join(import.meta.dirname, "..", "..", "packages", "tools");
    const entryPath = Bun.resolveSync("@anthropic-ai/sandbox-runtime/package.json", fromDir);
    return dirname(entryPath);
}

async function main() {
    const { targets, skipBuild, out } = parseArgs();
    const distBinaries = join(import.meta.dirname, "..", "..", "packages", "cli", "dist", "binaries");
    const buildBinariesScript = join(import.meta.dirname, "..", "..", "packages", "cli", "build-binaries.ts");

    if (existsSync(out)) {
        console.log(`Cleaning existing context dir: ${out}`);
        await $`rm -rf ${out}`;
    }
    mkdirSync(out, { recursive: true });

    for (const target of targets) {
        const srcDir = join(distBinaries, target);

        if (!skipBuild) {
            console.log(`\n▶ Building ${target}...`);
            const result = await $`bun ${buildBinariesScript} --target ${target}`.nothrow();
            if (result.exitCode !== 0) {
                console.error(`✗ build-binaries.ts failed for ${target}`);
                process.exit(1);
            }
        }

        if (!existsSync(srcDir) || readdirSync(srcDir).length === 0) {
            console.error(`✗ No artifacts found for "${target}" at ${srcDir}.`);
            console.error(skipBuild
                ? `  --skip-build was set — artifacts must already exist (e.g. downloaded by CI).`
                : `  Build appeared to succeed but produced no output.`);
            process.exit(1);
        }

        const destDir = join(out, target);
        mkdirSync(destDir, { recursive: true });
        for (const entry of readdirSync(srcDir)) {
            // Rename the arch-specific exe to a plain `pizza` so the Dockerfile
            // doesn't need to know the binary name for each TARGETARCH.
            const dest = entry.startsWith("pizza-linux-") ? "pizza" : entry;
            cpSync(join(srcDir, entry), join(destDir, dest), { recursive: true });
        }
        console.log(`✓ Staged ${target} → ${destDir}`);
    }

    // Seccomp vendor files (see fact #4 in the container spike): apply-seccomp
    // + unix-block.bpf let the standalone binary's bundled sandbox-runtime
    // find seccomp support without node/npm in the image.
    const sandboxRuntimeDir = resolveSandboxRuntimeDir();
    for (const target of targets) {
        const arch = SECCOMP_ARCH_MAP[target];
        const srcSeccompDir = join(sandboxRuntimeDir, "vendor", "seccomp", arch);
        if (!existsSync(srcSeccompDir)) {
            console.error(`✗ Missing seccomp vendor files at ${srcSeccompDir}`);
            process.exit(1);
        }
        const destSeccompDir = join(out, "seccomp", arch);
        mkdirSync(destSeccompDir, { recursive: true });
        cpSync(srcSeccompDir, destSeccompDir, { recursive: true });
        console.log(`✓ Staged seccomp/${arch}`);
    }

    cpSync(join(import.meta.dirname, "entrypoint.sh"), join(out, "entrypoint.sh"));

    console.log(`\n✅ Build context ready: ${out}`);
    console.log(`   docker buildx build --platform linux/amd64,linux/arm64 -f docker/runner/Dockerfile ${out}`);
}

await main();
