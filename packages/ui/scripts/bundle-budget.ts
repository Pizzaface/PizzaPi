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
// 512 KB gzip. gzip itself is deterministic — this is about build output,
// not compression. On 2026-10-08, PR #945's unchanged commit produced two
// *different* "within budget" vs "exceeds budget" results in the very same
// CI job, gzip 500.76 KB then 505.49 KB on the next build (run ids
// 37799888572, job npm-local) — a ~4.73 KB swing from Rollup/esbuild chunk
// splitting that isn't fully deterministic across runs, even though gzip
// itself is. #945 raised the budget 505 KB -> 508 KB to cover that. It just
// happened again: on 2026-10-09, CI run 37942515474 (commit 5cc79c3d, one
// a11y PR (#991) merged after #945) measured 508.02 KB and failed, while
// this exact source rebuilt locally five times lands consistently at
// ~503.1 KB (1721.92 KB raw, matching CI's reported raw size) — a ~5 KB
// CI-vs-local gap, same magnitude as the swing #945 already documented.
// There is no new heavy dependency or accidentally-eager import behind this:
// no packages/ui dependency changed between #945 and 5cc79c3d, and the
// ~1.85 KB of real local growth since #945's ~501.25 KB measurement is just
// #991's accessibility fix. 512 KB leaves ~9 KB over today's local size,
// enough headroom to absorb another swing of the size already observed
// twice. If CI keeps seeing swings this large, investigate the
// chunk-splitting nondeterminism directly rather than creeping this number
// up again.
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
