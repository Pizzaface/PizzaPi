/**
 * UI bundle budget check.
 *
 * Reads the main entry script from the built `dist/index.html` (so hashed
 * filenames don't matter), gzips it, and fails if the compressed size exceeds
 * the budget. No third-party dependencies — uses only Node/Bun stdlib.
 */
import fs from "fs";
import path from "path";
import { gzipSync } from "zlib";

const DIST_DIR = path.resolve(import.meta.dir, "../dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");
// 512 KB gzip. The local gzip size for a given commit is reproducible
// (±0.05 KB across repeated builds here), but CI's esbuild/Rollup minify
// pass is not: on 2026-10-08, PR #945's unchanged commit produced two
// *different* "within budget" vs "exceeds budget" results in the very same
// CI job — identical 1712.84 KB raw minified output both times, but gzip
// 500.76 KB then 505.49 KB on the next build (run ids 37799888572, job
// npm-local). 505 KB left ~0 KB of margin against that swing even though
// neither build actually grew the app. Budget bumped to restore headroom;
// shrink real growth instead of creeping this number back down.
const BUDGET_BYTES = 512 * 1024;

function formatBytes(bytes: number): string {
    return `${(bytes / 1024).toFixed(2)} KB`;
}

function findMainScript(): string | null {
    if (!fs.existsSync(INDEX_HTML)) {
        console.error(`Missing ${INDEX_HTML}; run the UI build first.`);
        return null;
    }
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    const match = html.match(/<script[^>]*\ssrc=["']([^"']+index-[^"']+\.js)["']/);
    return match ? match[1] : null;
}

const mainScript = findMainScript();
if (!mainScript) {
    console.error("Could not find main index-*.js entry in dist/index.html");
    process.exit(1);
}

const assetPath = path.join(DIST_DIR, mainScript.replace(/^\//, ""));
if (!fs.existsSync(assetPath)) {
    console.error(`Main script not found on disk: ${assetPath}`);
    process.exit(1);
}

const raw = fs.readFileSync(assetPath);
const gzipped = gzipSync(raw);
const ok = gzipped.length <= BUDGET_BYTES;

console.log(`Main entry: ${mainScript}`);
console.log(`  minified: ${formatBytes(raw.length)}`);
console.log(`  gzip:     ${formatBytes(gzipped.length)}`);
console.log(`  budget:   ${formatBytes(BUDGET_BYTES)}`);
console.log(`  status:   ${ok ? "✅ within budget" : "❌ exceeds budget"}`);

process.exit(ok ? 0 : 1);
