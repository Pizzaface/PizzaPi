export interface SessionCloseMetadata {
    cwd: string;
    sessionFile?: string;
    updatedAt: number;
}

export interface RunningSessionLookup {
    has(sessionId: string): boolean;
}

export interface SessionCloseMetadataRetention {
    ttlMs: number;
    withFileTtlMs: number;
    maxEntries: number;
}

export const DEFAULT_SESSION_CLOSE_METADATA_RETENTION: SessionCloseMetadataRetention = {
    ttlMs: 60 * 60_000,
    withFileTtlMs: 24 * 60 * 60_000,
    maxEntries: 1_000,
};

export function pruneSessionCloseMetadata(
    metadata: Map<string, SessionCloseMetadata>,
    runningSessions: RunningSessionLookup,
    now = Date.now(),
    retention: SessionCloseMetadataRetention = DEFAULT_SESSION_CLOSE_METADATA_RETENTION,
): number {
    let deleted = 0;

    for (const [id, entry] of metadata) {
        if (runningSessions.has(id)) continue;
        const ttl = entry.sessionFile ? retention.withFileTtlMs : retention.ttlMs;
        if (now - entry.updatedAt >= ttl) {
            metadata.delete(id);
            deleted += 1;
        }
    }

    if (metadata.size <= retention.maxEntries) return deleted;

    const prunable = Array.from(metadata.entries())
        .filter(([id]) => !runningSessions.has(id))
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

    for (const [id] of prunable) {
        if (metadata.size <= retention.maxEntries) break;
        if (metadata.delete(id)) deleted += 1;
    }

    return deleted;
}

