import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const PACKAGED_BINARY_ASSETS = [
    "package.json",
    "theme",
    "export-html",
    "templates",
    "skills",
    "photon_rs_bg.wasm",
] as const;

export function copyBinaryAssets(piPkgDir: string, outDir: string): void {
    cpSync(join(piPkgDir, "package.json"), join(outDir, "package.json"));

    for (const [source, destination] of [
        [join(piPkgDir, "dist", "modes", "interactive", "theme"), "theme"],
        [join(piPkgDir, "dist", "core", "export-html"), "export-html"],
        [join(import.meta.dirname, "templates"), "templates"],
        [join(import.meta.dirname, "skills"), "skills"],
    ]) {
        if (existsSync(source)) cpSync(source, join(outDir, destination), { recursive: true });
    }

    // Photon looks beside process.execPath when running from a compiled binary.
    const requireFromPi = createRequire(join(piPkgDir, "package.json"));
    cpSync(requireFromPi.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"), join(outDir, "photon_rs_bg.wasm"));
}
