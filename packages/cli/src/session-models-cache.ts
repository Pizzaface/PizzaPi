/**
 * Session models cache — bridges extension-registered providers to the daemon.
 *
 * Pi package extensions (e.g. minimalcc-pi's claude-subscription provider) register
 * custom providers at session runtime via pi.registerProvider(). Those providers only
 * exist inside a live session's ModelRegistry — the daemon builds its registry from
 * disk (auth.json + models.json) and never sees them, so Web UI model selectors fed
 * by /api/runners/:id/models (Runner Settings → Models / Fast Model) miss them.
 *
 * Fix: the remote extension snapshots the live session's model list to this cache;
 * the daemon and `pizza models` merge it into their disk-registry list.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ponytail: 7-day TTL — stale entries only linger if a package is uninstalled and no
// session starts afterward; every new session overwrites the snapshot.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionModelEntry {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
}

function cachePath(): string {
    // Same convention as ollama-cloud-models cache: HOME env first so tests can redirect.
    return join(process.env.HOME || homedir(), ".pizzapi", "session-models-cache.json");
}

function isEntry(value: unknown): value is SessionModelEntry {
    if (typeof value !== "object" || value === null) return false;
    const m = value as Record<string, unknown>;
    return (
        typeof m.provider === "string" &&
        typeof m.id === "string" &&
        typeof m.name === "string" &&
        typeof m.reasoning === "boolean" &&
        typeof m.contextWindow === "number"
    );
}

/** Read the cached session model snapshot. Returns null if missing, corrupt, or stale. */
export function readSessionModelsCache(): SessionModelEntry[] | null {
    const path = cachePath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        if (
            typeof raw !== "object" || raw === null ||
            !Array.isArray(raw.models) || typeof raw.fetchedAt !== "number"
        ) return null;
        if (Date.now() - raw.fetchedAt >= CACHE_TTL_MS) return null;
        return raw.models.filter(isEntry);
    } catch {
        return null;
    }
}

let lastWritten: string | null = null;

/** Snapshot the live session's model list. No-ops when the list is unchanged. */
export function writeSessionModelsCache(models: SessionModelEntry[]): void {
    if (models.length === 0) return;
    const serialized = JSON.stringify(models);
    if (serialized === lastWritten) return;
    try {
        const dir = join(process.env.HOME || homedir(), ".pizzapi");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(cachePath(), JSON.stringify({ models, fetchedAt: Date.now() }), { mode: 0o600 });
        lastWritten = serialized;
    } catch {
        // Best-effort cache — never break the session over it.
    }
}

/** Test hook: reset the write-dedupe memo. */
export function resetSessionModelsCacheMemo(): void {
    lastWritten = null;
}

/**
 * Union two model lists keyed by provider:id. Entries in `preferred` win conflicts.
 * Result is sorted by provider, then id.
 */
export function mergeModelLists<T extends SessionModelEntry>(preferred: T[], extra: T[]): T[] {
    const seen = new Set(preferred.map((m) => `${m.provider}:${m.id}`));
    return [...preferred, ...extra.filter((m) => !seen.has(`${m.provider}:${m.id}`))].sort((a, b) => {
        if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
        return a.id.localeCompare(b.id);
    });
}
