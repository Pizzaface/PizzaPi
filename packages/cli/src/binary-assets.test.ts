import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyBinaryAssets, PACKAGED_BINARY_ASSETS } from "../binary-assets.js";

let outputDir: string | undefined;
afterEach(() => {
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

describe("copyBinaryAssets", () => {
    test("copies Photon WASM beside the compiled binary", () => {
        const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
        const piPkgDir = dirname(dirname(entry));
        outputDir = mkdtempSync(join(tmpdir(), "pizzapi-binary-assets-"));

        copyBinaryAssets(piPkgDir, outputDir);

        for (const asset of PACKAGED_BINARY_ASSETS) {
            expect(existsSync(join(outputDir, asset))).toBe(true);
        }
    });
});
