import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Relay session id → transcript file ───────────────────────────────────────
//
// A relay session id (PIZZAPI_SESSION_ID) and a pi transcript id are different
// identifiers: the .jsonl is named after the pi id, so `findSessionPathById`
// can never resolve a relay id.  The daemon learns the pairing at runtime from
// the worker's `session_metadata` IPC, but that lived only in memory — so any
// respawn after a daemon restart (relay wake, UI reconnect) started the same
// relay session on a BRAND NEW empty transcript and lost the conversation.
//
// This file persists the pairing so a respawn of a known relay session resumes
// the conversation it already had.

const MAX_LINKS = 500;

interface LinkEntry {
    sessionFile: string;
    updatedAt: number;
}

export function sessionTranscriptLinksPath(): string {
    return join(homedir(), ".pizzapi", "session-transcript-links.json");
}

function readLinks(path: string): Record<string, LinkEntry> {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" && parsed.links && typeof parsed.links === "object"
            ? parsed.links as Record<string, LinkEntry>
            : {};
    } catch {
        return {};
    }
}

/**
 * Record the transcript a relay session is currently writing to.
 * Called on every `session_metadata` IPC, so it follows /new and resume.
 */
export function recordTranscriptLink(
    sessionId: string,
    sessionFile: string,
    path = sessionTranscriptLinksPath(),
): void {
    if (!sessionId || !sessionFile) return;
    try {
        const links = readLinks(path);
        if (links[sessionId]?.sessionFile === sessionFile) return;
        links[sessionId] = { sessionFile, updatedAt: Date.now() };

        // ponytail: prune by age on write — a few hundred entries is a ~50KB
        // file, so no separate sweep task.
        const ids = Object.keys(links);
        if (ids.length > MAX_LINKS) {
            ids.sort((a, b) => (links[a]!.updatedAt) - (links[b]!.updatedAt));
            for (const id of ids.slice(0, ids.length - MAX_LINKS)) delete links[id];
        }

        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify({ links }), "utf-8");
        renameSync(tmp, path);
    } catch {
        // Best effort: losing a link only costs the resume, never the session.
    }
}

/** The transcript this relay session last wrote to, if the file still exists. */
export function lookupTranscriptLink(
    sessionId: string,
    path = sessionTranscriptLinksPath(),
): string | undefined {
    if (!sessionId) return undefined;
    const entry = readLinks(path)[sessionId];
    if (!entry?.sessionFile) return undefined;
    return existsSync(entry.sessionFile) ? entry.sessionFile : undefined;
}
