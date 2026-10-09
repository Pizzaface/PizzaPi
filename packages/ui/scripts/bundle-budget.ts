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
// 508 KB gzip. gzip itself is deterministic — this is about build output,
// not compression: on 2026-10-08, PR #945's unchanged commit produced two
// *different* "within budget" vs "exceeds budget" results in the very same
// CI job, gzip 500.76 KB then 505.49 KB on the next build (run ids
// 37799888572, job npm-local). Both builds reported the same 1712.84 KB raw
// size to 2 decimal places, but that's not proof of byte-identical output —
// Rollup/esbuild's chunk splitting isn't fully deterministic across runs, so
// two builds can land on the same total length while differing in content
// (e.g. different per-chunk content-hash strings of the same length), which
// gzips to a different size. The old 505 KB budget left ~0 KB of margin
// against that swing. Measured on this branch: ~501.25 KB locally across
// five rebuilds (513265–513283 bytes, <0.02 KB jitter — the CI-observed
// 4.73 KB swing hasn't reproduced locally). 508 KB leaves ~2.5 KB over the
// worst CI result seen so far and ~7 KB over today's actual size — tighter
// than the previous 512 KB bump, which silently handed main ~11 KB of slack.
// If CI keeps seeing swings this large, investigate the chunk-splitting
// nondeterminism directly rather than creeping this number up again.
const BUDGET_BYTES = 508 * 1024;

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
