/**
 * Serves static files from the UI dist directory.
 * Falls back to index.html for SPA client-side routing.
 */

import { existsSync } from "fs";
import { join, extname, resolve } from "path";

// Resolve UI dist directory. Check in order:
// 1. PIZZAPI_UI_DIR env var
// 2. Sibling package (monorepo layout): ../ui/dist
// 3. Relative to server dist: ../../ui/dist
function resolveUiDir(): string | null {
    if (process.env.PIZZAPI_UI_DIR) {
        const dir = resolve(process.env.PIZZAPI_UI_DIR);
        if (existsSync(dir)) return dir;
    }

    const base = import.meta.dirname ?? __dirname;
    const candidates = [
        resolve(base, "../../ui/dist"),
        resolve(base, "../../../packages/ui/dist"),
    ];

    for (const dir of candidates) {
        if (existsSync(join(dir, "index.html"))) return dir;
    }

    return null;
}

const UI_DIR = resolveUiDir();

if (UI_DIR) {
    console.log(`[static] Serving UI from ${UI_DIR}`);
} else {
    console.log("[static] No UI dist found — static file serving disabled");
}

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".webmanifest": "application/manifest+json",
};

export async function serveStaticFile(pathname: string): Promise<Response | null> {
    if (!UI_DIR) return null;

    // Don't serve API or socket.io paths
    if (pathname.startsWith("/api/") || pathname.startsWith("/socket.io/")) return null;

    // Prevent path traversal
    const safePath = pathname.replace(/\.\./g, "").replace(/\/+/g, "/");
    let filePath = join(UI_DIR, safePath === "/" ? "index.html" : safePath);

    // If file doesn't exist, serve index.html for SPA routing
    if (!existsSync(filePath)) {
        filePath = join(UI_DIR, "index.html");
    }

    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";

    try {
        const file = Bun.file(filePath);
        if (!(await file.exists())) return null;

        return new Response(file, {
            headers: {
                "content-type": mime,
                "cache-control": cacheControl,
            },
        });
    } catch {
        return null;
    }
}
