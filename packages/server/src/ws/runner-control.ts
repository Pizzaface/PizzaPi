type PendingSpawn = {
    resolve: (value: { ok: true } | { ok: false; message: string }) => void;
    timer: ReturnType<typeof setTimeout>;
};

const pendingSpawns = new Map<string, PendingSpawn>();

export function waitForSpawnAck(sessionId: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; message: string } | { ok: false; message: string; timeout: true }> {
    // If there is already a pending waiter, just overwrite; session IDs should be unique.
    const existing = pendingSpawns.get(sessionId);
    if (existing) {
        clearTimeout(existing.timer);
        pendingSpawns.delete(sessionId);
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingSpawns.delete(sessionId);
            resolve({ ok: false, message: "Spawn acknowledgement timed out", timeout: true });
        }, timeoutMs);

        pendingSpawns.set(sessionId, { resolve, timer });
    });
}

export function resolveSpawnReady(sessionId: string) {
    const pending = pendingSpawns.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSpawns.delete(sessionId);
    pending.resolve({ ok: true });
}

export function resolveSpawnError(sessionId: string, message: string) {
    const pending = pendingSpawns.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSpawns.delete(sessionId);
    pending.resolve({ ok: false, message });
}
