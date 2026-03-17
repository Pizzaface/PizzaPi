/**
 * Session-scoped attachment storage on the runner.
 *
 * Persists attachments downloaded from the relay server into a directory
 * structure keyed by relay session ID:
 *
 *   ~/.pizzapi/session-attachments/{sessionId}/{sanitized-filename}
 *
 * Each attachment has a companion `.meta.json` sidecar with metadata.
 * Attachments live as long as the session does — no independent TTL.
 */

import { mkdir, rm, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AttachmentMeta {
    /** Original filename from the upload */
    filename: string;
    /** MIME type */
    mediaType: string;
    /** Size in bytes */
    size: number;
    /** ISO timestamp when saved */
    savedAt: string;
    /** The stored filename on disk (may differ from original due to dedup) */
    storedAs: string;
}

export interface SavedAttachment {
    /** Absolute path to the stored file */
    filePath: string;
    /** Metadata */
    meta: AttachmentMeta;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_ROOT = join(homedir(), ".pizzapi", "session-attachments");

function getRoot(): string {
    return process.env.PIZZAPI_SESSION_ATTACHMENTS_DIR ?? DEFAULT_ROOT;
}

function sessionDir(sessionId: string): string {
    return join(getRoot(), sanitize(sessionId));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Per-session mutex to serialize save operations.
 * Prevents concurrent saves from reading the same directory snapshot and
 * choosing identical filenames (the readdir→write sequence is non-atomic).
 */
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // Run fn after previous completes (even on error)
    // Store the void-typed chain so subsequent callers wait for us
    sessionLocks.set(sessionId, next.then(() => {}, () => {}));
    return next;
}

/** Sanitize a string for use as a filesystem path component. */
function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Deduplicate a filename within a directory listing.
 * If "photo.png" already exists, returns "photo-2.png", "photo-3.png", etc.
 */
function deduplicateFilename(desired: string, existing: Set<string>): string {
    if (!existing.has(desired)) return desired;

    const dotIdx = desired.lastIndexOf(".");
    const base = dotIdx > 0 ? desired.slice(0, dotIdx) : desired;
    const ext = dotIdx > 0 ? desired.slice(dotIdx) : "";

    let counter = 2;
    while (existing.has(`${base}-${counter}${ext}`)) {
        counter++;
    }
    return `${base}-${counter}${ext}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save an attachment to the session-scoped directory.
 *
 * @param sessionId  Relay session ID
 * @param filename   Original filename (will be sanitized)
 * @param mediaType  MIME type
 * @param data       Raw file contents as a Buffer
 * @returns          Metadata about the saved file
 */
export async function saveSessionAttachment(
    sessionId: string,
    filename: string,
    mediaType: string,
    data: Buffer,
): Promise<SavedAttachment> {
    // Serialize saves per session so the readdir→write dedup sequence is atomic.
    return withSessionLock(sessionId, async () => {
        const dir = sessionDir(sessionId);
        await mkdir(dir, { recursive: true });

        // Read existing files for deduplication
        let existingFiles: Set<string>;
        try {
            const entries = await readdir(dir);
            existingFiles = new Set(entries);
        } catch {
            existingFiles = new Set();
        }

        const safeName = sanitize(filename || "attachment");
        const storedAs = deduplicateFilename(safeName, existingFiles);
        const filePath = join(dir, storedAs);

        await writeFile(filePath, data);

        const meta: AttachmentMeta = {
            filename,
            mediaType,
            size: data.length,
            savedAt: new Date().toISOString(),
            storedAs,
        };

        // Write sidecar metadata
        const metaPath = `${filePath}.meta.json`;
        await writeFile(metaPath, JSON.stringify(meta, null, 2));

        return { filePath, meta };
    });
}

/**
 * List all attachments for a session.
 */
export async function listSessionAttachments(sessionId: string): Promise<AttachmentMeta[]> {
    const dir = sessionDir(sessionId);
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return [];
    }

    const metaFiles = entries.filter((e) => e.endsWith(".meta.json"));
    const results: AttachmentMeta[] = [];

    for (const metaFile of metaFiles) {
        try {
            const raw = await readFile(join(dir, metaFile), "utf-8");
            results.push(JSON.parse(raw) as AttachmentMeta);
        } catch {
            // Skip corrupt metadata files
        }
    }

    return results;
}

/**
 * Delete all attachments for a session (cleanup on session end).
 */
export async function cleanupSessionAttachments(sessionId: string): Promise<void> {
    const dir = sessionDir(sessionId);
    try {
        await rm(dir, { recursive: true, force: true });
    } catch {
        // Directory may not exist — that's fine
    }
    sessionLocks.delete(sessionId);
}

/**
 * Get the attachment directory path for a session.
 * Useful for external consumers that need to know where files are stored.
 */
export function getSessionAttachmentDir(sessionId: string): string {
    return sessionDir(sessionId);
}

/**
 * Sweep orphaned session attachment directories.
 *
 * Cross-references the directories under the attachment root against a set of
 * known active session IDs. Any directory whose name doesn't match an active
 * session is deleted. This handles cleanup after crashes, restarts, or sessions
 * that ended without a clean shutdown.
 *
 * @param activeSessionIds  Set of session IDs that are currently alive
 * @returns                 Number of orphaned directories removed
 */
export async function sweepOrphanedAttachments(activeSessionIds: Set<string>): Promise<number> {
    const root = getRoot();
    let entries: string[];
    try {
        entries = await readdir(root);
    } catch {
        return 0; // Root doesn't exist yet — nothing to sweep
    }

    let removed = 0;
    for (const entry of entries) {
        // Session dirs are sanitized session IDs — check against active set
        if (activeSessionIds.has(entry)) continue;

        const dirPath = join(root, entry);
        try {
            const s = await stat(dirPath);
            if (!s.isDirectory()) continue;
        } catch {
            continue;
        }

        try {
            await rm(dirPath, { recursive: true, force: true });
            removed++;
        } catch {
            // Best-effort — skip if removal fails
        }
    }

    if (removed > 0) {
        console.log(`pizzapi: swept ${removed} orphaned session attachment director${removed === 1 ? "y" : "ies"}`);
    }
    return removed;
}
