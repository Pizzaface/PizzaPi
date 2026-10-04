import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

export const PACKAGED_BINARY_ASSETS = [
    "package.json",
    "theme",
    "export-html",
    "templates",
    "skills",
    "README.md",
    "CHANGELOG.md",
    "docs",
    "examples",
    "pizzapi-docs",
    "photon_rs_bg.wasm",
] as const;

function copyIfExists(source: string, destination: string): void {
    if (existsSync(source)) cpSync(source, destination, { recursive: true });
}

export function copyBinaryAssets(piPkgDir: string, outDir: string): void {
    cpSync(join(piPkgDir, "package.json"), join(outDir, "package.json"));
    // pi's system prompt points at README/docs/examples under getPackageDir()
    // (= dirname(execPath) in a compiled binary), so they must sit beside it.
    cpSync(join(piPkgDir, "README.md"), join(outDir, "README.md"));
    copyIfExists(join(piPkgDir, "CHANGELOG.md"), join(outDir, "CHANGELOG.md"));
    cpSync(join(piPkgDir, "docs"), join(outDir, "docs"), { recursive: true, filter: (src) => !src.includes(`${sep}images`) });
    cpSync(join(piPkgDir, "examples"), join(outDir, "examples"), { recursive: true });

    for (const [source, destination] of [
        [join(piPkgDir, "dist", "modes", "interactive", "theme"), "theme"],
        [join(piPkgDir, "dist", "modes", "interactive", "assets"), "assets"],
        [join(piPkgDir, "dist", "core", "export-html"), "export-html"],
        [join(import.meta.dirname, "templates"), "templates"],
        [join(import.meta.dirname, "skills"), "skills"],
        [join(import.meta.dirname, "..", "..", "docs", "src", "content", "docs"), "pizzapi-docs"],
    ]) {
        copyIfExists(source, join(outDir, destination));
    }

    // Photon looks beside process.execPath when running from a compiled binary.
    const requireFromPi = createRequire(join(piPkgDir, "package.json"));
    cpSync(requireFromPi.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"), join(outDir, "photon_rs_bg.wasm"));
}
