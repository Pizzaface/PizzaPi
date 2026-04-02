/**
 * Session list cache — avoids re-parsing every .jsonl session file on each
 * /resume listing.  Caches SessionInfo metadata keyed by file path + mtime.
 *
 * On each scan:
 *  1. stat() every .jsonl file in the session directory
 *  2. If mtime matches the cached entry → cache hit (skip parsing)
 *  3. If mtime differs or entry is missing → parse the file (cache miss)
 *  4. Prune cache entries whose files no longer exist
 *  5. Persist the cache to ~/.pizzapi/session-list-cache.json
 *
 * The upstream SessionManager.list() reads & parses every file every time,
 * which is O(total-session-bytes).  This makes it O(number-of-files) for
 * the common case where most sessions haven't changed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile, stat, readdir } from "node:fs/promises";

/** Resolve home directory (respects $HOME override for tests). */
function resolveHome(): string {
    return process.env.HOME || homedir();
}
import type { SessionInfo } from "@mariozechner/pi-coding-agent";

// ── Cache file format ────────────────────────────────────────────────────────

const CACHE_VERSION = 1;

interface CachedSessionEntry {
    mtimeMs: number;
    sizeBytes: number;
    id: string;
    cwd: string;
    name: string | undefined;
    parentSessionPath: string | undefined;
    created: string;          // ISO string
    modified: string;         // ISO string
    messageCount: number;
    firstMessage: string;
    allMessagesText: string;
}

interface CacheFile {
    version: number;
    entries: Record<string, CachedSessionEntry>;
}

// ── In-memory state ──────────────────────────────────────────────────────────

let cache: Map<string, CachedSessionEntry> = new Map();
let cacheLoaded = false;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List sessions from a directory using the stat-based cache.
 * Drop-in replacement for SessionManager.list() in the resume context.
 */
export async function listSessionsCached(
    sessionDir: string,
): Promise<SessionInfo[]> {
    if (!cacheLoaded) {
        loadCacheFromDisk();
        cacheLoaded = true;
    }

    if (!existsSync(sessionDir)) return [];

    let files: string[];
    try {
        const entries = await readdir(sessionDir);
        files = entries.filter(f => f.endsWith(".jsonl")).map(f => join(sessionDir, f));
    } catch {
        return [];
    }

    // Track which paths exist this scan (for pruning)
    const livePathsInDir = new Set<string>();
    const results: SessionInfo[] = [];

    // Process files with concurrency control to avoid fd exhaustion
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (filePath) => {
            const resolved = resolve(filePath);
            livePathsInDir.add(resolved);

            try {
                const stats = await stat(resolved);
                const cached = cache.get(resolved);

                if (cached && cached.mtimeMs === stats.mtimeMs && cached.sizeBytes === stats.size) {
                    // Cache hit — reconstruct SessionInfo from cached data
                    return cachedEntryToSessionInfo(resolved, cached);
                }

                // Cache miss — parse the file
                const info = await parseSessionFile(resolved, stats);
                if (info) {
                    const entry = sessionInfoToCachedEntry(info, stats);
                    cache.set(resolved, entry);
                    return info;
                }
                return null;
            } catch {
                return null;
            }
        }));

        for (const info of batchResults) {
            if (info) results.push(info);
        }
    }

    // Prune deleted files from this directory
    for (const path of cache.keys()) {
        if (path.startsWith(sessionDir) && !livePathsInDir.has(path)) {
            cache.delete(path);
        }
    }

    // Persist asynchronously (best-effort, coalesced)
    persistCache();

    results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return results;
}

/**
 * Force a full cache invalidation (e.g. after session deletion).
 */
export function invalidateSessionListCache(): void {
    cache.clear();
    cacheLoaded = false;
    if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
}

/**
 * Find a session's `.jsonl` file path by session ID across all project directories.
 *
 * Scans the sessions root directory (e.g. `~/.pizzapi/agent/sessions/`) and checks
 * the in-memory cache first (O(N) over cache entries). If no cache hit, falls back
 * to scanning file headers. Returns `null` if not found.
 */
export async function findSessionPathById(
    sessionsRootDir: string,
    sessionId: string,
): Promise<string | null> {
    if (!cacheLoaded) {
        loadCacheFromDisk();
        cacheLoaded = true;
    }

    // Fast path: check cache for a matching session ID
    for (const [path, entry] of cache.entries()) {
        if (entry.id === sessionId) {
            // Verify file still exists
            if (existsSync(path)) return path;
            cache.delete(path);
        }
    }

    // Slow path: scan all project directories under sessionsRootDir
    if (!existsSync(sessionsRootDir)) return null;

    try {
        const dirEntries = readdirSync(sessionsRootDir, { withFileTypes: true });
        for (const dirEntry of dirEntries) {
            if (!dirEntry.isDirectory()) continue;
            const dirPath = join(sessionsRootDir, dirEntry.name);
            let files: string[];
            try {
                files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl"));
            } catch {
                continue;
            }
            for (const file of files) {
                const filePath = join(dirPath, file);
                try {
                    // Read just the first line to check the session ID
                    const content = readFileSync(filePath, "utf8");
                    const firstNewline = content.indexOf("\n");
                    const firstLine = firstNewline >= 0 ? content.slice(0, firstNewline) : content;
                    if (!firstLine.trim()) continue;
                    const header = JSON.parse(firstLine);
                    if (header.type === "session" && header.id === sessionId) {
                        return filePath;
                    }
                } catch {
                    continue;
                }
            }
        }
    } catch {
        // sessionsRootDir is not readable
    }

    return null;
}

// ── Parsing (mirrors upstream buildSessionInfo) ──────────────────────────────

interface RawEntry {
    type: string;
    id?: string;
    timestamp?: string;
    message?: { role?: string; content?: unknown; timestamp?: number };
    name?: string;
    cwd?: string;
    parentSession?: string;
}

function isMessageWithContent(msg: any): boolean {
    if (!msg || typeof msg !== "object") return false;
    const content = msg.content;
    if (typeof content === "string") return content.length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return false;
}

function extractTextContent(msg: any): string {
    if (!msg || typeof msg !== "object") return "";
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 500);
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                return part.text.slice(0, 500);
            }
        }
    }
    return "";
}

async function parseSessionFile(filePath: string, stats: { mtime: Date }): Promise<SessionInfo | null> {
    try {
        const content = await readFile(filePath, "utf8");
        const lines = content.trim().split("\n");
        const entries: RawEntry[] = [];
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                entries.push(JSON.parse(line));
            } catch {
                // Skip malformed lines
            }
        }
        if (entries.length === 0) return null;
        const header = entries[0];
        if (header.type !== "session") return null;

        let messageCount = 0;
        let firstMessage = "";
        const allMessages: string[] = [];
        let name: string | undefined;
        let lastActivityTime: number | undefined;

        for (const entry of entries) {
            if (entry.type === "session_info") {
                const n = (entry as any).name;
                if (typeof n === "string" && n.trim()) {
                    name = n.trim();
                }
            }
            if (entry.type !== "message") continue;
            const message = entry.message;
            if (!isMessageWithContent(message)) continue;
            if (message!.role !== "user" && message!.role !== "assistant") continue;
            messageCount++;

            // Track last activity time
            const msgTimestamp = message!.timestamp;
            if (typeof msgTimestamp === "number") {
                lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
            } else if (typeof entry.timestamp === "string") {
                const t = new Date(entry.timestamp).getTime();
                if (!Number.isNaN(t)) {
                    lastActivityTime = Math.max(lastActivityTime ?? 0, t);
                }
            }

            const textContent = extractTextContent(message);
            if (!textContent) continue;
            allMessages.push(textContent);
            if (!firstMessage && message!.role === "user") {
                firstMessage = textContent;
            }
        }

        const cwd = typeof header.cwd === "string" ? header.cwd : "";
        const parentSessionPath = header.parentSession;

        // Compute modified date (mirrors upstream getSessionModifiedDate)
        let modified: Date;
        if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
            modified = new Date(lastActivityTime);
        } else {
            const headerTime = typeof header.timestamp === "string"
                ? new Date(header.timestamp).getTime()
                : NaN;
            modified = !Number.isNaN(headerTime) ? new Date(headerTime) : stats.mtime;
        }

        return {
            path: filePath,
            id: header.id ?? "",
            cwd,
            name,
            parentSessionPath,
            created: new Date(header.timestamp ?? stats.mtime),
            modified,
            messageCount,
            firstMessage: firstMessage || "(no messages)",
            allMessagesText: allMessages.join(" "),
        };
    } catch {
        return null;
    }
}

// ── Conversion helpers ───────────────────────────────────────────────────────

function cachedEntryToSessionInfo(path: string, entry: CachedSessionEntry): SessionInfo {
    return {
        path,
        id: entry.id,
        cwd: entry.cwd,
        name: entry.name,
        parentSessionPath: entry.parentSessionPath,
        created: new Date(entry.created),
        modified: new Date(entry.modified),
        messageCount: entry.messageCount,
        firstMessage: entry.firstMessage,
        allMessagesText: entry.allMessagesText,
    };
}

function sessionInfoToCachedEntry(info: SessionInfo, stats: { mtimeMs: number; size: number }): CachedSessionEntry {
    return {
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
        id: info.id,
        cwd: info.cwd,
        name: info.name,
        parentSessionPath: info.parentSessionPath,
        created: info.created.toISOString(),
        modified: info.modified.toISOString(),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        allMessagesText: info.allMessagesText,
    };
}

// ── Disk persistence ─────────────────────────────────────────────────────────

function cacheFilePath(): string {
    return join(resolveHome(), ".pizzapi", "session-list-cache.json");
}

function loadCacheFromDisk(): void {
    try {
        const path = cacheFilePath();
        if (!existsSync(path)) return;
        const raw = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
        if (raw.version !== CACHE_VERSION) return;
        cache = new Map(Object.entries(raw.entries ?? {}));
    } catch {
        cache = new Map();
    }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistCache(): void {
    if (persistTimer !== null) return; // coalesce rapid writes
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
            const dir = join(resolveHome(), ".pizzapi");
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const data: CacheFile = {
                version: CACHE_VERSION,
                entries: Object.fromEntries(cache),
            };
            writeFileSync(cacheFilePath(), JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
        } catch {
            // Non-fatal
        }
    }, 100);
}

/** Flush any pending cache write immediately (for testing). */
export function flushSessionListCache(): void {
    if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
        try {
            const dir = join(resolveHome(), ".pizzapi");
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const data: CacheFile = {
                version: CACHE_VERSION,
                entries: Object.fromEntries(cache),
            };
            writeFileSync(cacheFilePath(), JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
        } catch {
            // Non-fatal
        }
    }
}
