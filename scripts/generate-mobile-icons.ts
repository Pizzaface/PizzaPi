/**
 * Generate native launcher icons for the Capacitor app from the PizzaPi
 * pizza SVG (`packages/ui/public/pizza.svg`).
 *
 * The SVG already contains a dark `#1c1917` background circle sized to fill its
 * viewBox, so it doubles as a maskable/adaptive icon: the dark circle edges
 * blend into the adaptive background color (`#1c1917`) set in
 * `res/values/ic_launcher_background.xml`.
 *
 * Outputs:
 *  - iOS:   single 1024×1024 AppIcon (iOS 13+ single-size icon)
 *  - Android legacy: ic_launcher.png + ic_launcher_round.png at all mipmap
 *    densities (the pizza fills the circle, so round == square)
 *  - Android adaptive foreground: ic_launcher_foreground.png scaled to ~66%
 *    centered on transparent, so the crust survives the adaptive safe-zone
 *    clip; adaptive background is the flat `#1c1917` color resource
 *
 * Requires ImageMagick `magick` on PATH.
 *
 *   bun run icons:generate
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = import.meta.dir + "/..";
const SVG = `${ROOT}/packages/ui/public/pizza.svg`;
const IOS_ICON = `${ROOT}/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`;
const ANDROID_RES = `${ROOT}/android/app/src/main/res`;

const DENSITIES = [
    ["mdpi", 48],
    ["hdpi", 72],
    ["xhdpi", 96],
    ["xxhdpi", 144],
    ["xxxhdpi", 192],
] as const;

const FG_DENSITIES = [
    ["mdpi", 108],
    ["hdpi", 162],
    ["xhdpi", 216],
    ["xxhdpi", 324],
    ["xxxhdpi", 432],
] as const;

function magick(args: string[]): void {
    const res = spawnSync("magick", args, { stdio: "inherit" });
    if (res.status !== 0) throw new Error(`magick failed: magick ${args.join(" ")}`);
}

function requireMagick(): void {
    const res = spawnSync("magick", ["-version"], { stdio: "pipe" });
    if (res.status !== 0 || !res.stdout) {
        throw new Error("ImageMagick `magick` not found on PATH. Install it (`brew install imagemagick`) and re-run.");
    }
}

function main(): void {
    requireMagick();
    if (!existsSync(SVG)) throw new Error(`pizza SVG not found: ${SVG}`);

    // Render the SVG at 2x (2048) for crisp anti-aliasing, then downsample to
    // a 1024 base. librsvg honors the SVG width/height attributes, so we bump
    // them to 2048 in a temp copy to render natively sharp.
    const svgText = readFileSync(SVG, "utf-8");
    const bumped = svgText.replace(
        /width="512" height="512"/,
        'width="2048" height="2048"',
    );
    const tmpSvg = "/tmp/pizzapi-icon-src.svg";
    writeFileSync(tmpSvg, bumped);

    const baseRgba = "/tmp/pizzapi-icon-base-rgba.png"; // transparent corners
    const baseDark = "/tmp/pizzapi-icon-base-dark.png"; // dark square (no alpha)
    const fgBase = "/tmp/pizzapi-icon-fg-1024.png";

    // Render the SVG on a transparent canvas. The pizza's dark `#1c1917`
    // background circle is inscribed in the viewBox, so the square corners are
    // transparent here — we composite onto the matching dark color for the
    // opaque iOS/legacy icons, and keep transparency for the adaptive fg.
    magick(["-background", "none", tmpSvg, "-resize", "1024x1024", baseRgba]);

    // Opaque dark square (no alpha channel) — iOS rejects icons with alpha, and
    // the legacy/round Android icons want a full-bleed dark background so the
    // rounded mask shows dark, not white, at the corners.
    magick(["-background", "#1c1917", baseRgba, "-flatten", baseDark]);

    // Adaptive foreground: pizza scaled to 66% centered on a transparent 1024
    // canvas via -extent, so the crust stays inside the adaptive safe zone
    // (~66%) and the adaptive background (`#1c1917`) shows through the padding.
    magick([
        baseRgba, "-resize", "675x675",
        "-background", "none", "-gravity", "center", "-extent", "1024x1024",
        fgBase,
    ]);

    // --- iOS ---
    mkdirSync(`${ROOT}/ios/App/App/Assets.xcassets/AppIcon.appiconset`, { recursive: true });
    // Strip the alpha channel entirely — Apple rejects icons with any alpha
    // metadata, even fully-opaque. baseDark is already opaque so this just
    // drops the channel.
    magick([baseDark, "-alpha", "off", IOS_ICON]);
    console.log(`✓ iOS AppIcon → ${IOS_ICON}`);

    // --- Android legacy (square + round identical) ---
    for (const [dir, size] of DENSITIES) {
        const d = `${ANDROID_RES}/mipmap-${dir}`;
        mkdirSync(d, { recursive: true });
        magick([baseDark, "-resize", `${size}x${size}`, `${d}/ic_launcher.png`]);
        magick([baseDark, "-resize", `${size}x${size}`, `${d}/ic_launcher_round.png`]);
    }
    console.log("✓ Android legacy ic_launcher + ic_launcher_round (5 densities)");

    // --- Android adaptive foreground ---
    for (const [dir, size] of FG_DENSITIES) {
        const d = `${ANDROID_RES}/mipmap-${dir}`;
        mkdirSync(d, { recursive: true });
        magick([fgBase, "-resize", `${size}x${size}`, `${d}/ic_launcher_foreground.png`]);
    }
    console.log("✓ Android adaptive ic_launcher_foreground (5 densities)");

    // Cleanup temp.
    rmSync(tmpSvg, { force: true });
    rmSync(baseRgba, { force: true });
    rmSync(baseDark, { force: true });
    rmSync(fgBase, { force: true });

    console.log("\nDone. Run `bunx cap sync` to refresh native assets if needed.");
}

try {
    main();
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}