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

/**
 * Authoritative (runnerId, parentSessionId) binding for a spawn request,
 * recorded the moment the server validates and dispatches `new_session` —
 * well before the child session ever registers with the relay. A worker
 * that fails before registering (e.g. a fail-closed sandbox) has no Redis
 * session record yet, so this is the only server-side source of truth that
 * authorizes the runner's `session_error` report for that sessionId. Never
 * trust the runner's own wire payload for this binding (see
 * isAuthorizedChildSpawnFailure in runner-spawn-failure.ts).
 */
type PendingChildSpawn = {
    runnerId: string;
    parentSessionId: string | null;
    userId?: string;
    timer: ReturnType<typeof setTimeout>;
};

// Generous enough to cover the worker startup window (WORKER_STARTUP_TIMEOUT_MS)
// plus retry/restart attempts before the child either registers (superseded by
// the durable Redis record) or is abandoned.
const PENDING_CHILD_SPAWN_TTL_MS = 5 * 60_000;
const pendingChildSpawns = new Map<string, PendingChildSpawn>();

export function recordPendingChildSpawn(sessionId: string, info: { runnerId: string; parentSessionId?: string; userId?: string }): void {
    const existing = pendingChildSpawns.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => pendingChildSpawns.delete(sessionId), PENDING_CHILD_SPAWN_TTL_MS);
    pendingChildSpawns.set(sessionId, { runnerId: info.runnerId, parentSessionId: info.parentSessionId ?? null, userId: info.userId, timer });
}

export function getPendingChildSpawn(sessionId: string): { runnerId: string; parentSessionId: string | null; userId?: string } | undefined {
    const entry = pendingChildSpawns.get(sessionId);
    if (!entry) return undefined;
    return { runnerId: entry.runnerId, parentSessionId: entry.parentSessionId, userId: entry.userId };
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

    for (const entry of pendingChildSpawns.values()) {
        clearTimeout(entry.timer);
    }
    pendingChildSpawns.clear();
}
