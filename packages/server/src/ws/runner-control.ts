type SpawnAckResult =
    | { ok: true }
    | { ok: false; message: string }
    | { ok: false; message: string; timeout: true };

type PendingSpawn = {
    resolve: (value: { ok: true } | { ok: false; message: string }) => void;
    timer: ReturnType<typeof setTimeout>;
};

type EarlySpawnAck = {
    result: { ok: true } | { ok: false; message: string };
    timer: ReturnType<typeof setTimeout>;
};

const EARLY_ACK_TTL_MS = 30_000;
const pendingSpawns = new Map<string, PendingSpawn>();
const earlySpawnAcks = new Map<string, EarlySpawnAck>();

function storeEarlySpawnAck(sessionId: string, result: { ok: true } | { ok: false; message: string }) {
    const existing = earlySpawnAcks.get(sessionId);
    if (existing) {
        clearTimeout(existing.timer);
        earlySpawnAcks.delete(sessionId);
    }

    const timer = setTimeout(() => {
        earlySpawnAcks.delete(sessionId);
    }, EARLY_ACK_TTL_MS);

    earlySpawnAcks.set(sessionId, { result, timer });
}

export function waitForSpawnAck(sessionId: string, timeoutMs: number): Promise<SpawnAckResult> {
    // If there is already a pending waiter, just overwrite; session IDs should be unique.
    const existing = pendingSpawns.get(sessionId);
    if (existing) {
        clearTimeout(existing.timer);
        pendingSpawns.delete(sessionId);
    }

    // If the runner acked before the waiter was registered, consume the
    // latched result immediately instead of waiting for timeout.
    const early = earlySpawnAcks.get(sessionId);
    if (early) {
        clearTimeout(early.timer);
        earlySpawnAcks.delete(sessionId);
        return Promise.resolve(early.result);
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
    if (pending) {
        clearTimeout(pending.timer);
        pendingSpawns.delete(sessionId);
        pending.resolve({ ok: true });
        return;
    }

    storeEarlySpawnAck(sessionId, { ok: true });
}

export function resolveSpawnError(sessionId: string, message: string) {
    const pending = pendingSpawns.get(sessionId);
    if (pending) {
        clearTimeout(pending.timer);
        pendingSpawns.delete(sessionId);
        pending.resolve({ ok: false, message });
        return;
    }

    storeEarlySpawnAck(sessionId, { ok: false, message });
}

/** @internal Test-only helper to clear module-global coordination state. */
export function _resetRunnerControlForTesting() {
    for (const pending of pendingSpawns.values()) {
        clearTimeout(pending.timer);
    }
    pendingSpawns.clear();

    for (const early of earlySpawnAcks.values()) {
        clearTimeout(early.timer);
    }
    earlySpawnAcks.clear();
}
