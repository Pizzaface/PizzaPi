import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyBinaryAssets, PACKAGED_BINARY_ASSETS } from "./binary-assets.js";

let outputDir: string | undefined;
afterEach(() => {
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

function findPiPackageDir(): string {
    let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    while (dir !== dirname(dir)) {
        const packageJson = join(dir, "package.json");
        if (existsSync(packageJson)) return dir;
        dir = dirname(dir);
    }
    throw new Error("Could not find pi-coding-agent package root");
}

describe("copyBinaryAssets", () => {
    test("copies Photon WASM beside the compiled binary", () => {
        const piPkgDir = findPiPackageDir();
        outputDir = mkdtempSync(join(tmpdir(), "pizzapi-binary-assets-"));

        copyBinaryAssets(piPkgDir, outputDir);

        for (const asset of PACKAGED_BINARY_ASSETS) {
            expect(existsSync(join(outputDir, asset))).toBe(true);
        }

        if (existsSync(join(piPkgDir, "dist", "modes", "interactive", "assets"))) {
            expect(existsSync(join(outputDir, "assets"))).toBe(true);
        }
    });
});
