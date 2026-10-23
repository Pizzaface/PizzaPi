/**
 * "Session is in Live voice mode" flag, shared by the runner service (writes)
 * and the session extension (reads). Runner and workers share a host, so a
 * file per session is the whole IPC. The overlay heartbeats it; a stale flag
 * (overlay closed without saying so) expires on its own.
 */
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LIVE_FLAG_TTL_MS = 2 * 60_000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function flagDir(home = homedir()): string {
    return join(home, ".pizzapi", "live", "active");
}

function flagPath(sessionId: string, home?: string): string | null {
    return SESSION_ID_RE.test(sessionId) ? join(flagDir(home), sessionId) : null;
}

export function setLive(sessionId: string, on: boolean, home?: string): boolean {
    const p = flagPath(sessionId, home);
    if (!p) return false;
    if (!on) {
        rmSync(p, { force: true });
        return true;
    }
    mkdirSync(flagDir(home), { recursive: true });
    if (existsSync(p)) {
        const now = new Date();
        utimesSync(p, now, now);
    } else {
        writeFileSync(p, "");
    }
    return true;
}

export function isLive(sessionId: string | undefined, home?: string, now = Date.now()): boolean {
    const p = sessionId ? flagPath(sessionId, home) : null;
    if (!p) return false;
    try {
        return now - statSync(p).mtimeMs < LIVE_FLAG_TTL_MS;
    } catch {
        return false;
    }
}
