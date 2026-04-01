// ============================================================================
// snapshot-provider.ts — SnapshotProvider abstraction
//
// Encapsulates the multi-layer snapshot fallback logic that was previously
// inlined in viewer.ts's `activateSession` closure.  Each snapshot source
// is an independently testable function, and the main orchestrator
// `getBestSnapshot()` tries them in priority order.
//
// Priority: delta replay > cache snapshot > in-memory state > persisted (SQLite)
// ============================================================================

import { getCachedRelayEventsAfterSeq, getLatestCachedSnapshotEvent } from "../../sessions/redis.js";
import { getPersistedRelaySessionSnapshot } from "../../sessions/store.js";
import type { CachedRelayEvent } from "./viewer-cache.js";
import { sendCachedDeltaReplayEvents } from "./viewer-cache.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union describing where a snapshot came from.
 */
export interface Snapshot {
    type: "cache-delta" | "cache-snapshot" | "memory" | "persisted";
    /** Human-readable description of the source */
    source: string;
}

/**
 * A ready-to-send snapshot result. Call `send()` to emit it to a viewer socket.
 */
export interface SnapshotResult {
    snapshot: Snapshot;
    send: (socket: ViewerEventEmitter, generation?: number) => void;
}

type ViewerEventEmitter = {
    emit: (...args: any[]) => any;
};

// ── Dependency injection for testability ─────────────────────────────────────

export interface SnapshotProviderDeps {
    getCachedRelayEventsAfterSeq: (sessionId: string, afterSeq: number) => Promise<CachedRelayEvent[]>;
    getLatestCachedSnapshotEvent: (sessionId: string) => Promise<Record<string, unknown> | null>;
    getPersistedRelaySessionSnapshot: (
        sessionId: string,
        userId: string,
    ) => Promise<{ state: unknown } | null>;
}

const defaultDeps: SnapshotProviderDeps = {
    getCachedRelayEventsAfterSeq,
    getLatestCachedSnapshotEvent,
    getPersistedRelaySessionSnapshot,
};

// ── Individual snapshot source functions ─────────────────────────────────────

/**
 * Try delta replay from Redis event cache.
 * Returns cached events after `afterSeq`, or null if unavailable/empty.
 */
export async function tryDeltaReplay(
    sessionId: string,
    afterSeq: number,
    deps: SnapshotProviderDeps = defaultDeps,
): Promise<SnapshotResult | null> {
    const cachedEvents = await deps.getCachedRelayEventsAfterSeq(sessionId, afterSeq);

    // Filter to events with valid seq (same logic as sendCachedDeltaReplayEvents)
    const hasValidEvents = cachedEvents.some(
        (e) => typeof e.seq === "number" && Number.isFinite(e.seq),
    );
    if (!hasValidEvents) return null;

    return {
        snapshot: { type: "cache-delta", source: `Redis delta replay after seq ${afterSeq}` },
        send(socket, generation) {
            sendCachedDeltaReplayEvents(socket, cachedEvents, generation);
        },
    };
}

/**
 * Try the latest full snapshot from the Redis event cache.
 * Scans from newest to oldest looking for a session_active or agent_end event.
 */
export async function tryCacheSnapshot(
    sessionId: string,
    deps: SnapshotProviderDeps = defaultDeps,
): Promise<SnapshotResult | null> {
    const snapshotEvent = await deps.getLatestCachedSnapshotEvent(sessionId);
    if (!snapshotEvent) return null;

    return {
        snapshot: { type: "cache-snapshot", source: "Redis cached snapshot event" },
        send(socket, generation) {
            socket.emit("event", { event: snapshotEvent, replay: true, generation });
        },
    };
}

/**
 * Try in-memory lastState from sio-registry (stored as JSON string in Redis session hash).
 * This is the fallback when the event cache is cold but the session is still live.
 */
export function tryMemoryState(
    lastState: string | null | undefined,
): SnapshotResult | null {
    if (!lastState) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(lastState);
    } catch {
        return null;
    }

    return {
        snapshot: { type: "memory", source: "In-memory lastState from Redis session hash" },
        send(socket, generation) {
            // Add _metaViaHub hint so the client knows metadata came from hub,
            // matching the original behavior in viewer.ts
            socket.emit("event", {
                event: { type: "session_active", state: parsed, _metaViaHub: true },
                generation,
            });
        },
    };
}

/**
 * Try persisted snapshot from SQLite (relay_session_state table).
 * This is the last resort for sessions that are no longer live.
 */
export async function tryPersistedSnapshot(
    sessionId: string,
    userId: string,
    deps: SnapshotProviderDeps = defaultDeps,
): Promise<SnapshotResult | null> {
    const snapshot = await deps.getPersistedRelaySessionSnapshot(sessionId, userId);
    if (!snapshot || snapshot.state === null || snapshot.state === undefined) return null;

    return {
        snapshot: { type: "persisted", source: "SQLite persisted relay session state" },
        send(socket, generation) {
            socket.emit("event", {
                event: { type: "session_active", state: snapshot.state },
                generation,
            });
        },
    };
}

// ── Main orchestrator ────────────────────────────────────────────────────────

export interface GetBestSnapshotOpts {
    /** Client's last known sequence number (for delta resume) */
    lastSeq?: number;
    /** User ID (required for persisted fallback) */
    userId?: string;
    /** JSON-stringified lastState from Redis session hash */
    lastState?: string | null;
    /** Whether a chunked delivery is in-flight (skip memory state if true) */
    chunkedPending?: boolean;
}

/**
 * Try to find the best available snapshot for a session, in priority order:
 *
 * 1. **Delta replay** — Redis event cache after lastSeq (only if lastSeq provided)
 * 2. **Cache snapshot** — Latest full snapshot from Redis event cache
 * 3. **Memory state** — In-memory lastState from Redis session hash (skip if chunkedPending)
 * 4. **Persisted** — SQLite fallback (only if userId provided)
 *
 * Returns the first successful result, or null if all sources fail.
 *
 * NOTE: When lastSeq is provided and delta replay fails, we do NOT fall back
 * to a snapshot — snapshots have no seq and could roll back the client's
 * transcript. We return null so the caller can trigger runner recovery.
 */
export async function getBestSnapshot(
    sessionId: string,
    opts: GetBestSnapshotOpts = {},
    deps: SnapshotProviderDeps = defaultDeps,
): Promise<SnapshotResult | null> {
    const { lastSeq, userId, lastState, chunkedPending } = opts;

    // ── Priority 1: Delta replay (only when lastSeq is provided) ─────────
    if (lastSeq !== undefined) {
        try {
            const delta = await tryDeltaReplay(sessionId, lastSeq, deps);
            if (delta) return delta;
        } catch {
            // Fall through — delta source failed
        }
        // When lastSeq is provided but delta fails, do NOT fall through to
        // snapshot — a snapshot has no seq and would roll back the client.
        return null;
    }

    // ── Priority 2: Cache snapshot ───────────────────────────────────────
    try {
        const cached = await tryCacheSnapshot(sessionId, deps);
        if (cached) return cached;
    } catch {
        // Fall through
    }

    // ── Priority 3: Memory state (skip during chunked delivery) ──────────
    if (!chunkedPending) {
        try {
            const memory = tryMemoryState(lastState);
            if (memory) return memory;
        } catch {
            // Fall through
        }
    }

    // ── Priority 4: Persisted snapshot (SQLite) ──────────────────────────
    if (userId) {
        try {
            const persisted = await tryPersistedSnapshot(sessionId, userId, deps);
            if (persisted) return persisted;
        } catch {
            // Fall through
        }
    }

    return null;
}
