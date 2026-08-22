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

import { getCachedRelayEventsAfterSeq, getLatestCachedSnapshotEvent, type LatestCachedSnapshot } from "../../sessions/redis.js";
import { getPersistedRelaySessionSnapshot } from "../../sessions/store.js";
import { applySnapshotOverlayToState } from "../sio-registry/snapshot-state.js";
import type { CachedRelayEvent } from "./viewer-cache.js";
import { sendCachedDeltaReplayEvents, snapshotCoverageSeq } from "./viewer-cache.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union describing where a snapshot came from.
 */
export interface Snapshot {
    type: "cache-delta" | "cache-snapshot" | "memory" | "persisted" | "already-current";
    /** Human-readable description of the source */
    source: string;
    /**
     * Seq this content is current as of, when known.
     *
     * Only set for sources that can prove their position in the event stream
     * (the Redis cache). `lastState` and the SQLite fallback are written on
     * session_active only — never on agent_end or deltas — so their true
     * position is unknown and MUST NOT be guessed from the session's current
     * seq: doing so would assert a currency the payload does not have and
     * poison the viewer's cursor.
     */
    seq?: number;
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

export const MESSAGE_TAIL_SIZE = 50;

export function truncateSnapshotMessages(
    state: Record<string, unknown>,
    tailSize: number = MESSAGE_TAIL_SIZE,
): Record<string, unknown> {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const totalMessages = messages.length;
    if (totalMessages <= tailSize) {
        return { ...state, totalMessages, hasMore: false, oldestLoadedIndex: 0 };
    }
    const startIndex = totalMessages - tailSize;
    return {
        ...state,
        messages: messages.slice(startIndex),
        totalMessages,
        hasMore: true,
        oldestLoadedIndex: startIndex,
    };
}

function maybeTruncateSnapshotState(state: unknown): unknown {
    if (!state || typeof state !== "object" || Array.isArray(state)) return state;
    if ((state as Record<string, unknown>).chunked === true) return state;
    return truncateSnapshotMessages(state as Record<string, unknown>);
}



// ── Dependency injection for testability ─────────────────────────────────────

export interface SnapshotProviderDeps {
    getCachedRelayEventsAfterSeq: (sessionId: string, afterSeq: number) => Promise<CachedRelayEvent[]>;
    getLatestCachedSnapshotEvent: (sessionId: string) => Promise<LatestCachedSnapshot | null>;
    getPersistedRelaySessionSnapshot: (
        sessionId: string,
        userId: string,
    ) => Promise<{ state: unknown; snapshotOverlay?: string | null } | null>;
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
    snapshotOverlay?: string | null,
    opts: { preserveLoadedHistory?: boolean } = {},
): Promise<SnapshotResult | null> {
    const cached = await deps.getLatestCachedSnapshotEvent(sessionId);
    if (!cached) return null;
    const snapshotEvent = cached.event;
    // A resuming viewer may have paged far past the 50-message tail. Replacing
    // its transcript with a truncated snapshot would silently erase that loaded
    // history on nothing more than a network blip, which is why the live
    // broadcast path in sio-registry/sessions.ts deliberately does not truncate
    // either. Truncation is a cold-start bandwidth guard, not a resume policy.
    const shrink = opts.preserveLoadedHistory
        ? (state: unknown) => state
        : maybeTruncateSnapshotState;

    return {
        snapshot: {
            type: "cache-snapshot",
            source: "Redis cached snapshot event",
            // Reach of the snapshot *plus* its trailing deltas, which is what a
            // caller must compare against a viewer's cursor.
            seq: snapshotCoverageSeq(cached) ?? undefined,
        },
        send(socket, generation) {
            let eventToSend: Record<string, unknown> = snapshotEvent;
            if (snapshotEvent.type === "session_active") {
                // The cached session_active predates later metadata changes
                // (session_metadata_update carries them but is intentionally not
                // cached). The snapshotOverlay accumulates those patches — queue,
                // model, todo list — so apply it or a stale snapshot clobbers the
                // viewer's restored follow-ups on switch.
                const state = applySnapshotOverlayToState(
                    shrink(snapshotEvent.state),
                    snapshotOverlay,
                );
                eventToSend = { ...snapshotEvent, state };
            } else if (Array.isArray(snapshotEvent.messages)) {
                eventToSend = shrink(snapshotEvent) as Record<string, unknown>;
            }
            socket.emit("event", { event: eventToSend, replay: true, generation });
            // Replay deltas cached after the snapshot. The viewer's cursor was
            // already advanced to the current seq via "connected", so without
            // this replay any events between the snapshot and that seq would
            // never reach the viewer — a permanently stale transcript until
            // the next full snapshot.
            sendCachedDeltaReplayEvents(socket, cached.eventsAfter, generation);
        },
    };
}

/**
 * Try in-memory lastState from sio-registry (stored as JSON string in Redis session hash).
 * This is the fallback when the event cache is cold but the session is still live.
 */
export function tryMemoryState(
    lastState: string | null | undefined,
    snapshotOverlay?: string | null,
): SnapshotResult | null {
    if (!lastState) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(lastState);
    } catch {
        return null;
    }

    const state = applySnapshotOverlayToState(maybeTruncateSnapshotState(parsed), snapshotOverlay);

    return {
        snapshot: { type: "memory", source: "In-memory lastState from Redis session hash" },
        send(socket, generation) {
            // Add _metaViaHub hint so the client knows metadata came from hub,
            // matching the original behavior in viewer.ts
            socket.emit("event", {
                event: { type: "session_active", state, _metaViaHub: true },
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
    snapshotOverlay?: string | null,
): Promise<SnapshotResult | null> {
    const snapshot = await deps.getPersistedRelaySessionSnapshot(sessionId, userId);
    if (!snapshot || snapshot.state === null || snapshot.state === undefined) return null;

    // Prefer the live Redis overlay (freshest); fall back to the persisted
    // overlay so metadata survives a relay restart / Redis loss.
    const overlay = snapshotOverlay ?? snapshot.snapshotOverlay;
    const state = applySnapshotOverlayToState(maybeTruncateSnapshotState(snapshot.state), overlay);

    return {
        snapshot: { type: "persisted", source: "SQLite persisted relay session state" },
        send(socket, generation) {
            socket.emit("event", {
                event: { type: "session_active", state },
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
    /** JSON-stringified metadata overlay (patches since the last full snapshot) */
    snapshotOverlay?: string | null;
    /** Whether a chunked delivery is in-flight (skip memory state if true) */
    chunkedPending?: boolean;
    /** Authoritative current seq, used to distinguish an empty replay from a gap. */
    latestSeq?: number;
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
 * A viewer that supplies `lastSeq` already holds a transcript, so anything we
 * send it must not rewind that transcript. The rule is a seq comparison, not a
 * mode switch: a source is safe when we can prove its position is at or ahead of
 * the client's cursor. Sources that cannot prove their position (`lastState`,
 * SQLite) are therefore reachable only for viewers hydrating from scratch.
 *
 * This used to be enforced by refusing to send *any* snapshot once `lastSeq` was
 * present, because the snapshot's own seq was discarded on the way out of
 * getLatestCachedSnapshotEvent(). That made an empty delta replay terminal:
 * the viewer received no transcript and no way to ask again, which is the
 * "blank until I hit refresh" bug.
 */
export async function getBestSnapshot(
    sessionId: string,
    opts: GetBestSnapshotOpts = {},
    deps: SnapshotProviderDeps = defaultDeps,
): Promise<SnapshotResult | null> {
    const { lastSeq, userId, lastState, snapshotOverlay, chunkedPending } = opts;

    // ── Resuming viewer: only seq-provable sources are safe ──────────────
    if (lastSeq !== undefined) {
        // 1a. Deltas after the client's cursor are the cheapest lossless resume.
        //     getCachedRelayEventsAfterSeq() already enforces strict seq
        //     contiguity and returns nothing if the cache was trimmed.
        try {
            const delta = await tryDeltaReplay(sessionId, lastSeq, deps);
            if (delta) return delta;
        } catch {
            // An unavailable delta source is not proof that the client is
            // current, even when latestSeq happens to match.
            return null;
        }

        // 1b. Nothing to replay and the client is provably level with the
        //     server: say so instead of resending a whole transcript it has.
        if (opts.latestSeq === lastSeq) {
            return {
                snapshot: {
                    type: "already-current",
                    source: "Viewer already at latest cached seq",
                    seq: lastSeq,
                },
                send() {},
            };
        }

        // 1c. The client is genuinely behind and deltas cannot repair it. A full
        //     snapshot is still safe when we can prove it reconstructs at least
        //     what the viewer already holds — the case the old code could not
        //     distinguish and so refused outright, going blank instead.
        try {
            const cached = await tryCacheSnapshot(sessionId, deps, snapshotOverlay, {
                preserveLoadedHistory: true,
            });
            const coverage = cached?.snapshot.seq;
            if (cached && coverage !== undefined && coverage >= lastSeq) {
                return cached;
            }
        } catch {
            // Fall through
        }

        // 1d. A real gap we cannot repair without risking a rewind. Recover
        //     through the runner rather than guessing with an unsequenced tier.
        return null;
    }

    // ── Priority 2: Cache snapshot ───────────────────────────────────────
    try {
        const cached = await tryCacheSnapshot(sessionId, deps, snapshotOverlay);
        if (cached) return cached;
    } catch {
        // Fall through
    }

    // ── Priority 3: Memory state (skip during chunked delivery) ──────────
    if (!chunkedPending) {
        try {
            const memory = tryMemoryState(lastState, snapshotOverlay);
            if (memory) return memory;
        } catch {
            // Fall through
        }
    }

    // ── Priority 4: Persisted snapshot (SQLite) ──────────────────────────
    if (userId) {
        try {
            const persisted = await tryPersistedSnapshot(sessionId, userId, deps, snapshotOverlay);
            if (persisted) return persisted;
        } catch {
            // Fall through
        }
    }

    return null;
}
